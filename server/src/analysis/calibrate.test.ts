import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { candlesAsOf, compareAll, sweep, type ManualOrder, type SymbolData } from './calibrate.ts';
import { analyze, DEFAULT_SR } from './sr.ts';
import type { Candle } from './types.ts';

const DAY = 86_400_000;
// Same breakout series as sr.test.ts: one resistance near 100 with a buy stop above it.
const SERIES: Candle[] = (
  [
    [98, 98.5, 97.5, 98], [98, 99, 97.8, 98.8], [98.8, 100, 98.6, 99.5], [99.5, 99.6, 98.5, 98.7],
    [98.7, 98.9, 97.9, 98.2], [98.2, 98.4, 97.0, 98.0], [98.0, 99.0, 97.6, 98.9], [98.9, 100.05, 98.8, 99.4],
    [99.4, 99.5, 98.3, 98.5], [98.5, 98.8, 97.8, 98.0], [98.0, 98.3, 97.5, 98.1], [98.1, 98.4, 97.7, 98.2],
    [98.2, 100.4, 98.1, 100.3], [100.3, 100.35, 98.9, 99.0], [98.9, 99.1, 98.4, 99.0], [99.0, 99.1, 98.2, 98.4],
  ] as [number, number, number, number][]
).map(([o, h, l, c], i) => ({ t: i * DAY, o, h, l, c }));

const data = new Map<string, SymbolData>([['TEST', { candles: SERIES, digits: 3 }]]);
const asOf = SERIES.length * DAY; // the day after the last candle
const auto = analyze('TEST', SERIES, { ...DEFAULT_SR, maxLinesPerSide: 0 }, 3).candidates.find((c) => c.side === 'buy' && c.entry)!;
const manual: ManualOrder = { id: 'm1', symbol: 'TEST', side: 'buy', entry: auto.entry!, sl: auto.sl!, tp: auto.tp!, asOf };

describe('candlesAsOf', () => {
  it('keeps only candles that opened before the order day', () => {
    assert.equal(candlesAsOf(SERIES, 10 * DAY).length, 10);
  });
});

describe('compareAll', () => {
  it('matches an order the engine itself would place', () => {
    const { rows, score } = compareAll([manual], data, DEFAULT_SR);
    assert.equal(rows[0]!.match, true);
    assert.equal(rows[0]!.dEntry, 0);
    assert.deepEqual(score, { matched: 1, total: 1, error: 0 });
  });

  it('reports the gap in ATR units when entry differs', () => {
    const { rows } = compareAll([{ ...manual, entry: manual.entry + 1 }], data, DEFAULT_SR);
    assert.equal(rows[0]!.match, false);
    assert.ok(rows[0]!.dEntry! < -0.5);
  });

  it('ignores candles from the order day onwards', () => {
    const early = compareAll([{ ...manual, asOf: 12 * DAY }], data, DEFAULT_SR);
    assert.equal(early.rows[0]!.match, false); // the breakout candle (day 12) did not exist yet
  });

  it('flags unknown symbols', () => {
    const { rows } = compareAll([{ ...manual, symbol: 'NONE' }], data, DEFAULT_SR);
    assert.equal(rows[0]!.reason, 'Belum ada data candle');
  });
});

describe('sweep', () => {
  it('finds parameters that reproduce the manual order when the current ones do not', () => {
    const off = { ...DEFAULT_SR, bufferAtr: 0.5 }; // entry 0.4 ATR away: outside the match band
    const result = sweep([manual], data, off);
    assert.equal(result.current.matched, 0);
    assert.equal(result.best[0]!.score.matched, 1);
    assert.equal(result.best[0]!.params.bufferAtr, 0.1);
    assert.ok(result.tried > 100);
  });
});
