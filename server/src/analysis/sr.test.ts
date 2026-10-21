import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyze, atr, clusterLines, DEFAULT_SR, fractals, roundTo } from './sr.ts';
import type { Candle } from './types.ts';

const DAY = 86_400_000;
const bars = (rows: [number, number, number, number][]): Candle[] =>
  rows.map(([o, h, l, c], i) => ({ t: i * DAY, o, h, l, c }));

// Two highs near 100 make a resistance line; candle 12 is a strong bullish breakout
// through it, then price falls back below so the line becomes a buy stop. Candle 14
// has a long lower wick just under the line: the rebound used for SL.
const SERIES = bars([
  [98, 98.5, 97.5, 98],
  [98, 99, 97.8, 98.8],
  [98.8, 100, 98.6, 99.5],
  [99.5, 99.6, 98.5, 98.7],
  [98.7, 98.9, 97.9, 98.2],
  [98.2, 98.4, 97.0, 98.0],
  [98.0, 99.0, 97.6, 98.9],
  [98.9, 100.05, 98.8, 99.4],
  [99.4, 99.5, 98.3, 98.5],
  [98.5, 98.8, 97.8, 98.0],
  [98.0, 98.3, 97.5, 98.1],
  [98.1, 98.4, 97.7, 98.2],
  [98.2, 100.4, 98.1, 100.3],
  [100.3, 100.35, 98.9, 99.0],
  [98.9, 99.1, 98.4, 99.0],
  [99.0, 99.1, 98.2, 98.4],
]);

// Price mirror: resistance becomes support, buy becomes sell.
const mirror = (c: Candle): Candle => ({ t: c.t, o: 200 - c.o, c: 200 - c.c, h: 200 - c.l, l: 200 - c.h });

describe('atr', () => {
  it('equals the constant true range of identical bars', () => {
    const flat = bars(Array.from({ length: 30 }, () => [1, 1.5, 0.5, 1] as [number, number, number, number]));
    assert.equal(roundTo(atr(flat, 14), 10), 1);
  });
});

describe('fractals', () => {
  it('finds strict 5-candle swing highs and lows', () => {
    const swings = fractals(SERIES, 2);
    assert.deepEqual(
      swings.filter((s) => s.kind === 'high').map((s) => s.i),
      [2, 7, 12],
    );
    assert.ok(swings.some((s) => s.kind === 'low' && s.i === 5));
  });

  it('ignores the last n candles that have no right side yet', () => {
    const swings = fractals(SERIES, 2);
    assert.ok(swings.every((s) => s.i <= SERIES.length - 3));
  });
});

describe('clusterLines', () => {
  it('merges prices within tolerance and drops single touches', () => {
    const lines = clusterLines([1.1, 1.1004, 1.2, 1.3, 1.3002, 1.3003], 0.001, 2);
    assert.equal(lines.length, 2);
    assert.equal(roundTo(lines[0]!.price, 5), 1.1002);
    assert.equal(lines[1]!.touches, 3);
  });

  it('does not chain close prices into one wide area', () => {
    const lines = clusterLines([1, 1.6, 1.9, 2.5], 1, 1);
    assert.deepEqual(lines.map((l) => l.touches), [3, 1]);
  });
});

describe('analyze', () => {
  const a = analyze('TEST', SERIES, DEFAULT_SR, 3);
  const buy = a.candidates.find((c) => c.side === 'buy' && !c.skipped);

  it('builds a buy stop above the resistance from the strong candle high plus buffer', () => {
    assert.ok(buy, 'expected a buy candidate');
    const buffer = DEFAULT_SR.bufferAtr * a.atr;
    assert.equal(buy.entry, roundTo(100.4 + buffer, 3));
    assert.equal(buy.strongAt, SERIES[12]!.t);
    assert.equal(buy.reboundAt, SERIES[14]!.t);
    assert.equal(buy.sl, roundTo(98.4 - buffer, 3));
    assert.ok(buy.sl! < buy.line && buy.line < buy.entry!);
  });

  it('uses RR 1:1.5 for TP when no line sits above (ATH)', () => {
    assert.equal(buy!.tpAuto, true);
    assert.equal(buy!.tp, roundTo(buy!.entry! + 1.5 * (buy!.entry! - buy!.sl!), 3));
  });

  it('mirrors into a sell stop for support', () => {
    const m = analyze('TEST', SERIES.map(mirror), DEFAULT_SR, 3);
    const sell = m.candidates.find((c) => c.side === 'sell' && !c.skipped);
    assert.ok(sell);
    assert.equal(sell.entry, roundTo(200 - buy!.entry!, 3));
    assert.equal(sell.sl, roundTo(200 - buy!.sl!, 3));
    assert.equal(sell.tp, roundTo(200 - buy!.tp!, 3));
  });

  it('skips a line with a reason when no strong candle exists', () => {
    const weak = SERIES.map((c, i) => (i === 12 ? { ...c, o: 99.5, c: 99.6 } : c));
    const w = analyze('TEST', weak, DEFAULT_SR, 3);
    const line = w.candidates.find((c) => c.side === 'buy');
    assert.ok(line);
    assert.match(line.skipped ?? '', /Candle kuat/);
    assert.equal(line.entry, undefined);
  });

  it('takes the next line beyond entry as TP', () => {
    const p = { ...DEFAULT_SR, minTouches: 1 };
    const withNext = analyze('TEST', SERIES, p, 3);
    const lower = withNext.candidates.find((c) => c.side === 'buy' && !c.skipped && !c.tpAuto);
    if (lower) assert.ok(lower.tp! > lower.entry!);
    for (const c of withNext.candidates) {
      if (c.skipped) continue;
      if (c.side === 'buy') assert.ok(c.sl! < c.entry! && c.entry! < c.tp!);
      else assert.ok(c.tp! < c.entry! && c.entry! < c.sl!);
    }
  });

  it('maxLinesPerSide keeps only the nearest lines but all of them as TP targets', () => {
    const all = analyze('TEST', SERIES, { ...DEFAULT_SR, minTouches: 1, maxLinesPerSide: 0 }, 3);
    const one = analyze('TEST', SERIES, { ...DEFAULT_SR, minTouches: 1, maxLinesPerSide: 1 }, 3);
    assert.equal(one.lines.length, all.lines.length);
    assert.ok(one.candidates.filter((c) => c.side === 'buy').length <= 1);
    assert.ok(one.candidates.filter((c) => c.side === 'sell').length <= 1);
    const nearestAbove = all.lines.find((l) => l.price > all.price)!;
    assert.equal(one.candidates.find((c) => c.side === 'buy')?.line, nearestAbove.price);
  });

  it('gives one shared entry to the nearest line only', () => {
    const many = analyze('TEST', SERIES, { ...DEFAULT_SR, minTouches: 1, clusterAtr: 0.01, maxLinesPerSide: 0 }, 3);
    const entries = many.candidates.filter((c) => c.entry !== undefined).map((c) => `${c.side}:${c.entry}`);
    assert.equal(new Set(entries).size, entries.length);
    // lines 100 and 100.05 are both broken by candle 12: 100.05 is nearer its entry
    const dup = many.candidates.find((c) => /Entry sama/.test(c.skipped ?? ''));
    assert.equal(dup?.line, 100);
    assert.ok(many.candidates.some((c) => c.line === 100.05 && c.entry !== undefined));
  });

  it('only uses the last `lookback` candles', () => {
    const short = analyze('TEST', SERIES, { ...DEFAULT_SR, lookback: 5 }, 3);
    assert.equal(short.lastCandleAt, SERIES[15]!.t);
    assert.equal(short.lines.length, 0);
  });
});
