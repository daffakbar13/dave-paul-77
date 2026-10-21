import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyze, atr, clusterLines, DEFAULT_SR, fractals, roundTo } from './sr.ts';
import type { Candle, SrParams } from './types.ts';

// The original concept model (strong candle + rebound) with its original line settings.
const STRONG: SrParams = { ...DEFAULT_SR, orderModel: 'strong', clusterAtr: 0.5, maxLinesPerSide: 0, minDistanceAtr: 0 };

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

describe('analyze (strong model)', () => {
  const a = analyze('TEST', SERIES, STRONG, 3);
  const buy = a.candidates.find((c) => c.side === 'buy' && !c.skipped);

  it('builds a buy stop above the resistance from the strong candle high plus buffer', () => {
    assert.ok(buy, 'expected a buy candidate');
    const buffer = STRONG.bufferAtr * a.atr;
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
    const m = analyze('TEST', SERIES.map(mirror), STRONG, 3);
    const sell = m.candidates.find((c) => c.side === 'sell' && !c.skipped);
    assert.ok(sell);
    assert.equal(sell.entry, roundTo(200 - buy!.entry!, 3));
    assert.equal(sell.sl, roundTo(200 - buy!.sl!, 3));
    assert.equal(sell.tp, roundTo(200 - buy!.tp!, 3));
  });

  it('skips a line with a reason when no strong candle exists', () => {
    const weak = SERIES.map((c, i) => (i === 12 ? { ...c, o: 99.5, c: 99.6 } : c));
    const w = analyze('TEST', weak, STRONG, 3);
    const line = w.candidates.find((c) => c.side === 'buy');
    assert.ok(line);
    assert.match(line.skipped ?? '', /Candle kuat/);
    assert.equal(line.entry, undefined);
  });

  it('takes the next line beyond entry as TP', () => {
    const p = { ...STRONG, minTouches: 1 };
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
    const all = analyze('TEST', SERIES, { ...STRONG, minTouches: 1, maxLinesPerSide: 0 }, 3);
    const one = analyze('TEST', SERIES, { ...STRONG, minTouches: 1, maxLinesPerSide: 1 }, 3);
    assert.equal(one.lines.length, all.lines.length);
    assert.ok(one.candidates.filter((c) => c.side === 'buy').length <= 1);
    assert.ok(one.candidates.filter((c) => c.side === 'sell').length <= 1);
    const nearestAbove = all.lines.find((l) => l.price > all.price)!;
    assert.equal(one.candidates.find((c) => c.side === 'buy')?.line, nearestAbove.price);
  });

  it('gives one shared entry to the nearest line only', () => {
    const many = analyze('TEST', SERIES, { ...STRONG, minTouches: 1, clusterAtr: 0.01, maxLinesPerSide: 0 }, 3);
    const entries = many.candidates.filter((c) => c.entry !== undefined).map((c) => `${c.side}:${c.entry}`);
    assert.equal(new Set(entries).size, entries.length);
    // lines 100 and 100.05 are both broken by candle 12: 100.05 is nearer its entry
    const dup = many.candidates.find((c) => /Entry sama/.test(c.skipped ?? ''));
    assert.equal(dup?.line, 100);
    assert.ok(many.candidates.some((c) => c.line === 100.05 && c.entry !== undefined));
  });

  it('only uses the last `lookback` candles', () => {
    const short = analyze('TEST', SERIES, { ...STRONG, lookback: 5 }, 3);
    assert.equal(short.lastCandleAt, SERIES[15]!.t);
    assert.equal(short.lines.length, 0);
  });
});

describe('analyze (ladder model)', () => {
  // 30 quiet bars around 1.105 (ATR about 0.004); the user's lines at 1.100, 1.110, 1.125
  const quiet: Candle[] = Array.from({ length: 30 }, (_, i) => ({ t: i * DAY, o: 1.105, h: 1.107, l: 1.103, c: 1.105 }));
  const lines = [1.1, 1.11, 1.125];
  const a = analyze('EURUSD', quiet, DEFAULT_SR, 5, undefined, { manualLines: lines });
  const buy = a.candidates.find((c) => c.side === 'buy' && c.line === 1.11)!;
  const sell = a.candidates.find((c) => c.side === 'sell')!;

  it('uses the manual lines instead of automatic ones', () => {
    assert.deepEqual(a.lines.map((l) => l.price), lines);
    assert.ok(a.lines.every((l) => l.source === 'manual'));
  });

  it('places entry, SL and TP by the gap to the next line', () => {
    // g = 0.015: entry +0.22g, SL -0.16g, TP = next line - 0.07g
    assert.equal(buy.entry, 1.1133);
    assert.equal(buy.sl, 1.1076);
    assert.equal(buy.tp, 1.12395);
    assert.equal(buy.tpAuto, false);
  });

  it('uses the gap behind and an RR TP at the last line', () => {
    // no line below 1.100: g = 0.010 (to 1.110), TP = entry - 1.5 x risk
    assert.equal(sell.entry, 1.0978);
    assert.equal(sell.sl, 1.1016);
    assert.equal(sell.tpAuto, true);
    assert.equal(sell.tp, roundTo(1.0978 - 1.5 * (1.1016 - 1.0978), 5));
  });

  it('widens SL to the minimum pips of the pair', () => {
    const wide = analyze('EURUSD', quiet, DEFAULT_SR, 5, undefined, { manualLines: lines, minSlPips: 100 });
    const b = wide.candidates.find((c) => c.side === 'buy' && c.line === 1.11)!;
    assert.equal(b.sl, roundTo(1.1133 - 0.01, 5));
  });

  it('skips lines too close to price without using up the per-side limit', () => {
    const close = analyze('EURUSD', quiet, { ...DEFAULT_SR, maxLinesPerSide: 1 }, 5, 1.1095, { manualLines: lines });
    const buys = close.candidates.filter((c) => c.side === 'buy');
    assert.equal(buys[0]!.skipped, 'Terlalu dekat harga');
    assert.equal(buys.filter((c) => !c.skipped).length, 1);
    assert.equal(buys.find((c) => !c.skipped)!.line, 1.125);
  });

  it('gives about 1.9 RR on evenly spaced lines', () => {
    const even = analyze('EURUSD', quiet, DEFAULT_SR, 5, undefined, { manualLines: [1.09, 1.1, 1.11, 1.12, 1.13] });
    const c = even.candidates.find((x) => x.side === 'buy' && x.line === 1.11)!;
    const rr = (c.tp! - c.entry!) / (c.entry! - c.sl!);
    assert.ok(rr > 1.8 && rr < 1.95, String(rr));
  });
});
