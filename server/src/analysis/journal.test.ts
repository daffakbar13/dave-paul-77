import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { audit, foldDeals, maxDrawdown, slipR, stats, type AuditTrade, type Deal, type TradePlan } from './journal.ts';

const deal = (d: Partial<Deal>): Deal => ({
  ticket: 1, order: 10, time: new Date('2026-11-03T08:00:00Z'), side: 'buy', entry: 'in', reason: 'expert',
  volume: 0.5, price: 1.1, sl: 1.098, tp: 1.104, profit: 0, commission: -1.75, swap: 0, fee: 0, comment: 'EURUSD:buy-1.09950', ...d,
});

const plan = (p: Partial<TradePlan> = {}): TradePlan => ({
  commandId: 'c1', placedAt: new Date('2026-11-02T00:00:00Z'), aggressive: 'auto', line: 1.0995, lineSource: 'manual',
  entry: 1.1, sl: 1.098, tp: 1.104, tpAuto: false, slFrom: 'ladder', lot: 0.5, risk: 100, rr: 2, multiplier: 1, atr: 0.008,
  newsAffected: false, ...p,
});

const trade = (t: Partial<AuditTrade>): AuditTrade => ({
  symbol: 'EURUSD', side: 'buy', openedAt: new Date('2026-11-03T08:00:00Z'), closedAt: new Date('2026-11-04T08:00:00Z'),
  openPrice: 1.1, closeReason: 'tp', net: 200, plan: plan(), ...t,
});

describe('foldDeals', () => {
  it('keeps a pending order without deals as it was', () => {
    assert.equal(foldDeals([], 'placed').status, 'placed');
    assert.equal(foldDeals([], 'cancelled').status, 'cancelled');
  });

  it('a fill opens the position', () => {
    const s = foldDeals([deal({})], 'placed');
    assert.equal(s.status, 'open');
    assert.equal(s.openPrice, 1.1);
    assert.equal(s.volume, 0.5);
    assert.equal(s.closedAt, null);
    assert.equal(s.net, -1.75);
  });

  it('a revived cancelled order (filled just before the delete) opens too', () => {
    assert.equal(foldDeals([deal({})], 'cancelled').status, 'open');
  });

  it('partial closes add up; the last exit gives the close time and reason', () => {
    const s = foldDeals([
      deal({}),
      deal({ ticket: 3, entry: 'out', side: 'sell', reason: 'tp', volume: 0.25, price: 1.104, profit: 100, commission: -0.88, time: new Date('2026-11-05T00:00:00Z') }),
      deal({ ticket: 2, entry: 'out', side: 'sell', reason: 'manual', volume: 0.25, price: 1.102, profit: 50, commission: -0.87, time: new Date('2026-11-04T00:00:00Z') }),
    ], 'placed');
    assert.equal(s.status, 'closed');
    assert.equal(s.closeReason, 'tp');
    assert.equal(s.closedAt?.toISOString(), '2026-11-05T00:00:00.000Z');
    assert.equal(s.closePrice, 1.103);
    assert.equal(s.profit, 150);
    assert.equal(s.costs, -3.5);
    assert.equal(s.net, 146.5);
  });

  it('stays open while volume is left', () => {
    const s = foldDeals([deal({}), deal({ ticket: 2, entry: 'out', volume: 0.2, profit: 10 })], 'placed');
    assert.equal(s.status, 'open');
  });
});

describe('audit numbers', () => {
  it('win rate, profit factor and R from the planned risk', () => {
    const s = stats([trade({ net: 200 }), trade({ net: -100, closeReason: 'sl' }), trade({ net: -100, closeReason: 'sl' }), trade({ net: 50, plan: null })]);
    assert.equal(s.trades, 4);
    assert.equal(s.wins, 2);
    assert.equal(s.winRate, 0.5);
    assert.equal(s.net, 50);
    assert.equal(s.profitFactor, 1.25);
    assert.equal(s.totalR, 0); // the trade without a plan has no R
    assert.equal(s.avgR, 0);
  });

  it('no loss: profit factor is null, not infinite', () => {
    assert.equal(stats([trade({})]).profitFactor, null);
  });

  it('drawdown follows the close order', () => {
    const d = (day: number, net: number) => trade({ net, closedAt: new Date(Date.UTC(2026, 10, day)) });
    assert.equal(maxDrawdown([d(4, -50), d(1, 100), d(2, -80), d(3, 30)]), 100); // 100 -> 20 -> 50 -> 0
  });

  it('slippage is measured against the planned risk, worse is positive for both sides', () => {
    assert.ok(Math.abs(slipR(trade({ openPrice: 1.1004 }))! - 0.2) < 1e-9);
    const sell = trade({ side: 'sell', openPrice: 1.0996, plan: plan({ entry: 1.1, sl: 1.102 }) });
    assert.ok(Math.abs(slipR(sell)! - 0.2) < 1e-9);
  });
});

describe('findings', () => {
  it('an empty month says so', () => {
    const a = audit([], { placed: 0, filled: 0, cancelled: 0, rate: null }, 0);
    assert.equal(a.findings.length, 1);
    assert.match(a.findings[0]!.text, /Belum ada trade/);
  });

  it('flags a losing pair, many SL hits, losing Aggressive and slippage', () => {
    const loss = (p: Partial<AuditTrade>) => trade({ net: -100, closeReason: 'sl', openPrice: 1.1005, ...p });
    const trades = [
      loss({ symbol: 'GBPJPY' }), loss({ symbol: 'GBPJPY' }), loss({ symbol: 'GBPJPY', plan: plan({ multiplier: 2 }) }),
      loss({ plan: plan({ multiplier: 2 }) }), trade({ net: 200 }),
    ];
    const a = audit(trades, { placed: 12, filled: 5, cancelled: 7, rate: 5 / 12 }, 0);
    const text = a.findings.map((f) => f.text).join('\n');
    assert.match(text, /GBPJPY: 3 trade/);
    assert.match(text, /close di SL/);
    assert.match(text, /Aggressive: 2 trade, net -200/);
    assert.match(text, /Fill rata-rata/);
    assert.match(text, /5 dari 12 level/);
    assert.equal(a.byMode.find((g) => g.key === 'Aggressive')?.trades, 2);
  });
});
