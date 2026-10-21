import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrderRow } from './orders.ts';
import { markRunning, type OpenPosition } from './positions.ts';

const row = (id: string, side: 'buy' | 'sell', entry: number, sl: number, status: OrderRow['status'] = 'valid'): OrderRow => ({
  id, symbol: 'EURUSD', side, type: side === 'buy' ? 'buy stop' : 'sell stop', line: entry, entry, sl, tp: entry + (entry - sl) * 2,
  tpAuto: false, lot: 0.5, risk: 100, rr: 2, lowRr: false, multiplier: 1, status,
});
const pos = (p: Partial<OpenPosition>): OpenPosition => ({
  ticket: 1, symbol: 'EURUSD', side: 'buy', volume: 0.5, openPrice: 1.1, sl: 1.098, tp: 1.104, comment: '', ...p,
});

// buy levels 20 pips apart, risk 20 pips each
const rows = [row('EURUSD:buy-1.10000', 'buy', 1.1, 1.098), row('EURUSD:buy-1.10200', 'buy', 1.102, 1.1)];

describe('markRunning', () => {
  it('matches by the level id in the comment even when the fill slipped', () => {
    const out = markRunning(rows, [pos({ ticket: 7, comment: 'EURUSD:buy-1.10200', openPrice: 1.10255 })]);
    assert.equal(out[1]!.status, 'running');
    assert.equal(out[1]!.position, 7);
    assert.equal(out[0]!.status, 'valid');
  });

  it('falls back to the nearest entry within 30% of the SL distance', () => {
    const out = markRunning(rows, [pos({ ticket: 8, openPrice: 1.10004 })]); // 0.4 pip slippage, no comment
    assert.deepEqual(out.map((r) => r.status), ['running', 'valid']);
  });

  it('does not match a fill too far from any entry', () => {
    const out = markRunning(rows, [pos({ openPrice: 1.1009 })]); // 9 pips off, tolerance 6
    assert.deepEqual(out.map((r) => r.status), ['valid', 'valid']);
  });

  it('ignores the other side and other pairs', () => {
    const out = markRunning(rows, [pos({ side: 'sell' }), pos({ ticket: 2, symbol: 'GBPUSD' })]);
    assert.ok(out.every((r) => r.status === 'valid'));
  });

  it('gives each position to one level and each level one position', () => {
    const out = markRunning(rows, [pos({ ticket: 1, openPrice: 1.10001 }), pos({ ticket: 2, openPrice: 1.10002 })]);
    assert.equal(out.filter((r) => r.status === 'running').length, 1);
    assert.equal(out[0]!.position, 1);
  });

  it('wins over invalid: price is usually past the entry of a filled level', () => {
    const out = markRunning([row('EURUSD:buy-1.10000', 'buy', 1.1, 1.098, 'invalid')], [pos({ comment: 'EURUSD:buy-1.10000' })]);
    assert.equal(out[0]!.status, 'running');
  });
});
