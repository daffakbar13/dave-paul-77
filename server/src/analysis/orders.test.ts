import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { currenciesOf, evaluate, sizeLot, summarize, type EvalInput } from './orders.ts';
import type { SymbolSpec } from './types.ts';

const EURUSD: SymbolSpec = { digits: 5, point: 0.00001, tickSize: 0.00001, tickValue: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, stopsLevel: 0 };
// USD account: 0.001 JPY on 100k units = 100 JPY = 100 / 150 USD
const USDJPY: SymbolSpec = { digits: 3, point: 0.001, tickSize: 0.001, tickValue: 100 / 150, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, stopsLevel: 10 };
// 100 oz contract, 0.01 tick = 1 USD
const XAUUSD: SymbolSpec = { digits: 2, point: 0.01, tickSize: 0.01, tickValue: 1, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, stopsLevel: 0 };

describe('sizeLot', () => {
  it('EURUSD: 10 USD over 50 pips is 0.02 lot', () => {
    assert.deepEqual(sizeLot(10, 1.1, 1.095, EURUSD), { lot: 0.02, risk: 10 });
  });

  it('rounds down so risk never exceeds the target', () => {
    const { lot, risk } = sizeLot(10, 1.1, 1.0967, EURUSD); // 33 pips -> 0.0303 lot
    assert.equal(lot, 0.03);
    assert.ok(risk <= 10);
  });

  it('USDJPY uses the JPY tick value', () => {
    // 100 pips = 1000 ticks x 0.6667 = 666.67 USD per lot; 10 USD -> 0.015 -> 0.01
    const { lot, risk } = sizeLot(10, 150, 149, USDJPY);
    assert.equal(lot, 0.01);
    assert.equal(risk, 6.67);
  });

  it('XAUUSD: 20 USD over 10 USD move is 0.02 lot', () => {
    assert.deepEqual(sizeLot(20, 2400, 2390, XAUUSD), { lot: 0.02, risk: 20 });
  });

  it('does not lose a step to float error', () => {
    assert.equal(sizeLot(30, 1.1, 1.099, EURUSD).lot, 0.3);
  });

  it('caps at the broker maximum', () => {
    assert.equal(sizeLot(1e9, 2400, 2390, XAUUSD).lot, 50);
  });
});

const base: EvalInput = {
  symbol: 'EURUSD',
  candidate: { id: 'EURUSD:buy-1.10000', side: 'buy', line: 1.1, entry: 1.101, sl: 1.096, tp: 1.111, tpAuto: false },
  cancelled: false,
  spec: EURUSD,
  quote: { bid: 1.095, ask: 1.0951 },
  balance: 10_000,
  riskPct: 0.1,
  multiplier: 1,
  rrThreshold: 1.5,
  offset: 0,
};

describe('evaluate', () => {
  it('computes lot, risk and RR for a valid row', () => {
    const row = evaluate(base);
    assert.equal(row.status, 'valid');
    assert.equal(row.lot, 0.02);
    assert.equal(row.risk, 10);
    assert.equal(row.rr, 2);
    assert.equal(row.lowRr, false);
  });

  it('Aggressive multiplies the risk', () => {
    const row = evaluate({ ...base, multiplier: 2 });
    assert.equal(row.lot, 0.04);
    assert.equal(row.multiplier, 2);
  });

  it('flags low RR but keeps the row valid', () => {
    const row = evaluate({ ...base, candidate: { ...base.candidate, tp: 1.106 } });
    assert.equal(row.status, 'valid');
    assert.equal(row.lowRr, true);
  });

  it('is invalid once price passed the entry', () => {
    const row = evaluate({ ...base, quote: { bid: 1.1012, ask: 1.1013 } });
    assert.equal(row.status, 'invalid');
    assert.match(row.reason!, /melewati entry/);
  });

  it('is invalid inside the stops level', () => {
    const row = evaluate({ ...base, spec: { ...EURUSD, stopsLevel: 1000 } });
    assert.equal(row.status, 'invalid');
    assert.match(row.reason!, /stops level/);
  });

  it('is invalid below the broker minimum lot', () => {
    const row = evaluate({ ...base, balance: 100 });
    assert.equal(row.status, 'invalid');
    assert.match(row.reason!, /minimum/);
  });

  it('keeps skipped lines visible with their reason', () => {
    const row = evaluate({ ...base, candidate: { id: 'x', side: 'sell', line: 1.09, skipped: 'Pantulan tidak ditemukan' } });
    assert.equal(row.status, 'skipped');
    assert.equal(row.reason, 'Pantulan tidak ditemukan');
    assert.equal(row.lot, null);
  });

  it('applies the MT4 to MT5 price offset', () => {
    const row = evaluate({ ...base, offset: 0.0002 });
    assert.equal(row.entry, 1.1012);
    assert.equal(row.sl, 1.0962);
  });
});

describe('summary', () => {
  it('sums risk per currency over valid rows only', () => {
    const rows = [
      evaluate(base),
      evaluate({ ...base, symbol: 'USDJPY', spec: USDJPY, quote: { bid: 148, ask: 148.01 }, candidate: { id: 'j', side: 'buy', line: 150, entry: 150, sl: 149, tp: 152 } }),
      evaluate({ ...base, cancelled: true }),
    ];
    const s = summarize(rows);
    assert.equal(s.orders, 2);
    assert.deepEqual(s.byCurrency, { EUR: 10, USD: 16.67, JPY: 6.67 });
  });

  it('splits symbols with broker suffixes', () => {
    assert.deepEqual(currenciesOf('XAUUSD.m'), ['XAU', 'USD']);
  });
});
