import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { replayOrders, runBacktest } from './backtest.ts';
import { DEFAULT_PATTERN, detectPatterns, patternOrders, patternStats, type DayLines, type PatternParams } from './patterns.ts';
import { DEFAULT_SR } from './sr.ts';
import type { Candle, Line } from './types.ts';

const DAY = 86_400_000;
const bars = (rows: [number, number, number, number][]): Candle[] => rows.map(([o, h, l, c], i) => ({ t: i * DAY, o, h, l, c }));
const line = (price: number): Line => ({ price, touches: 2, low: price, high: price });
// fixed lines every morning, ATR 1 (zone 0.3): support 96, resistance 100, next 106
const fixedDays = (n: number, prices = [96, 100, 106], atr = 1): DayLines[] => Array.from({ length: n }, () => ({ atr, lines: prices.map(line) }));

// Top 1 on candle 2 (high 100.1), a drop to 98.0, top 2 on candle 6 (high 99.9), the
// first bearish candle 7 (low 99.0), then price falls to the target 96 + 0.07 x 4 = 96.28.
const TOP: [number, number, number, number][] = [
  [98.0, 98.4, 97.8, 98.2],
  [98.2, 99.0, 98.1, 98.9],
  [98.9, 100.1, 98.8, 99.2], // top 1
  [99.2, 99.3, 98.5, 98.6],
  [98.6, 98.7, 98.0, 98.3], // the drop: 2 ATR under the line
  [98.3, 99.5, 98.2, 99.4],
  [99.4, 99.9, 99.1, 99.5], // top 2
  [99.5, 99.6, 99.0, 99.1], // confirmation
  [99.1, 99.2, 98.0, 98.1],
  [98.1, 98.2, 97.0, 97.1],
  [97.1, 97.2, 96.2, 96.4], // target reached
  [96.4, 96.8, 96.3, 96.6],
];
const mirror = (c: Candle): Candle => ({ t: c.t, o: 200 - c.o, h: 200 - c.l, l: 200 - c.h, c: 200 - c.c });
const pp = (o: Partial<PatternParams> = {}): PatternParams => ({ ...DEFAULT_PATTERN, ...o });
const near = (a: number | null | undefined, b: number) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

describe('detectPatterns', () => {
  it('finds a double top that reaches its target', () => {
    const cs = bars(TOP);
    const [e, ...rest] = detectPatterns(cs, fixedDays(cs.length));
    assert.equal(rest.length, 0);
    assert.equal(e!.kind, 'top');
    assert.equal(e!.first.i, 2);
    assert.equal(e!.second.i, 6);
    near(e!.line, 100);
    near(e!.extreme, 100.1);
    near(e!.breakLevel, 100.2);
    near(e!.target, 96.28);
    assert.equal(e!.status, 'success');
    assert.equal(e!.resolvedAt, 10 * DAY);
  });

  it('needs the drop between the tops', () => {
    const cs = bars(TOP);
    assert.equal(detectPatterns(cs, fixedDays(cs.length), pp({ minDropAtr: 2.5 })).length, 0);
    // a shallow dip is one long push: the later candle carries the first top on
    const flat = bars(TOP.map((r, i) => (i >= 3 && i <= 5 ? [99.2, 99.4, 99.1, 99.3] : r)));
    assert.equal(detectPatterns(flat, fixedDays(flat.length)).length, 0);
  });

  it('marks the breakout branch as fail', () => {
    const rows = TOP.slice(0, 8);
    rows.push([99.1, 100.4, 99.0, 100.3]);
    const cs = bars(rows);
    const [e] = detectPatterns(cs, fixedDays(cs.length));
    assert.equal(e!.status, 'fail');
    assert.equal(e!.resolvedAt, 8 * DAY);
  });

  it('leaves a candle reaching both sides grey', () => {
    const rows = TOP.slice(0, 8);
    rows.push([99.1, 100.4, 96.0, 97]);
    const cs = bars(rows);
    const [e] = detectPatterns(cs, fixedDays(cs.length));
    assert.equal(e!.status, 'grey');
    assert.equal(e!.greyBy, 'both');
  });

  it('forgets the first top once a candle closes above the zone', () => {
    const rows = TOP.map((r, i) => (i === 5 ? ([98.3, 100.6, 98.2, 100.5] as typeof r) : r));
    rows[6] = [100.5, 100.5, 99.1, 99.5]; // opens above the line: not a top either
    const cs = bars(rows);
    assert.equal(detectPatterns(cs, fixedDays(cs.length)).length, 0);
  });

  it('finds the mirrored double bottom', () => {
    const cs = bars(TOP).map(mirror);
    const [e, ...rest] = detectPatterns(cs, fixedDays(cs.length, [94, 100, 104]));
    assert.equal(rest.length, 0);
    assert.equal(e!.kind, 'bottom');
    near(e!.line, 100);
    near(e!.extreme, 99.9);
    near(e!.breakLevel, 99.8);
    near(e!.target, 103.72);
    assert.equal(e!.status, 'success');
  });

  it('makes the second top the first top of the next pattern', () => {
    const rows = TOP.slice(0, 7);
    rows.push([99.5, 99.6, 98.6, 98.7], [98.7, 98.8, 98.4, 98.5], [98.5, 99.9, 98.4, 99.6]); // drop, top 3
    const cs = bars(rows);
    const es = detectPatterns(cs, fixedDays(cs.length));
    assert.deepEqual(es.map((e) => [e.first.i, e.second.i]), [[2, 6], [6, 9]]);
  });

  it('never looks ahead: earlier patterns are the same on a shorter history', () => {
    const cs = bars(TOP);
    const full = detectPatterns(cs, fixedDays(cs.length));
    const cut = detectPatterns(cs.slice(0, 7), fixedDays(7));
    assert.deepEqual(cut.map((e) => [e.first, e.second, e.extreme]), full.map((e) => [e.first, e.second, e.extreme]));
  });

  it('counts per kind and year', () => {
    const cs = bars(TOP);
    const s = patternStats(detectPatterns(cs, fixedDays(cs.length)));
    assert.deepEqual(s.top, { patterns: 1, success: 1, fail: 0, grey: 0 });
    assert.deepEqual(s.bottom, { patterns: 0, success: 0, fail: 0, grey: 0 });
    assert.deepEqual(s.byYear.get(1970)!.top.patterns, 1);
  });
});

describe('patternOrders', () => {
  const cs = bars(TOP);
  const days = fixedDays(cs.length);
  const events = detectPatterns(cs, days);

  it('places the reversal stop under the confirmation candle and the breakout stop above the tops', () => {
    const o = patternOrders('X', cs, days, events, DEFAULT_SR, pp(), 2);
    const [sell] = o['top-sell'].get(8)!;
    assert.deepEqual([sell!.side, sell!.entry, sell!.sl, sell!.tp], ['sell', 99, 100.2, 96.28]);
    const [buy] = o['top-buy'].get(7)!;
    // SL under the zone (100 - 0.3 - 0.1), TP before the next line (106 - 0.07 x 6)
    assert.deepEqual([buy!.side, buy!.entry, buy!.sl, buy!.tp], ['buy', 100.2, 99.6, 105.58]);
    // one day only by default
    assert.deepEqual([...o['top-buy'].keys()], [7]);
    assert.deepEqual([...o['top-sell'].keys()], [8]);
  });

  it('puts the SL behind the strong candle, as Breakout JohnPaul77 does', () => {
    // candle 7 (body 0.4 of 0.6, 0.4 ATR) is the nearest strong bearish candle above 99.0
    const wide = { ...DEFAULT_SR, slMaxRiskAtr: 1 };
    const [sell] = patternOrders('X', cs, days, events, wide, pp(), 2)['top-sell'].get(8)!;
    assert.deepEqual([sell!.sl, sell!.slFrom], [99.7, 'candle']);
    // at the default 0.6 ATR that SL is too wide: back to the pattern SL above the tops
    const [def] = patternOrders('X', cs, days, events, DEFAULT_SR, pp(), 2)['top-sell'].get(8)!;
    assert.deepEqual([def!.sl, def!.slFrom], [100.2, 'ladder']);
    // the mirror for the bottom: under the strong bullish candle
    const m = cs.map(mirror);
    const mdays = fixedDays(m.length, [94, 100, 104]);
    const [buy] = patternOrders('X', m, mdays, detectPatterns(m, mdays), wide, pp(), 2)['bottom-buy'].get(8)!;
    assert.deepEqual([buy!.sl, buy!.slFrom], [100.3, 'candle']);
  });

  it('withdraws the breakout once the reversal target is reached', () => {
    // no confirmation in reach (min RR 3): the breakout stays until candle 10 hits 96.28
    const o = patternOrders('X', cs, days, events, DEFAULT_SR, pp({ orderDays: 10, minRr: 3 }), 2);
    assert.deepEqual([...o['top-buy'].keys()], [7, 8, 9, 10]);
    assert.equal(o['top-sell'].size, 0);
  });

  it('takes a farther TP line with minTargetAtr', () => {
    const wide = fixedDays(cs.length, [93, 96, 100, 103, 106]);
    const o = patternOrders('X', cs, wide, detectPatterns(cs, wide, pp({ minTargetAtr: 5 })), DEFAULT_SR, pp({ minTargetAtr: 5, minRr: 1 }), 2);
    // 96 and 103 are within 5 ATR: the TPs come from 93 (93 + 0.07 x 7) and 106
    assert.equal(o['top-sell'].get(8)![0]!.tp, 93.49);
    assert.equal(o['top-buy'].get(7)![0]!.tp, 105.58);
  });

  it('withdraws the other branch once one entry is reached', () => {
    const o = patternOrders('X', cs, days, events, DEFAULT_SR, pp({ orderDays: 5 }), 2);
    // the reversal fills on candle 8, so the breakout is not placed after it
    assert.deepEqual([...o['top-buy'].keys()], [7, 8]);
    assert.deepEqual([...o['top-sell'].keys()], [8]);
  });

  it('enters near the close in close mode and skips a small RR', () => {
    const close = patternOrders('X', cs, days, events, DEFAULT_SR, pp({ entryMode: 'close' }), 2);
    assert.equal(close['top-sell'].get(8)![0]!.entry, 99.1);
    const strict = patternOrders('X', cs, days, events, DEFAULT_SR, pp({ minRr: 3 }), 2);
    assert.equal(strict['top-sell'].size, 0);
  });

  it('mirrors the orders for bottoms', () => {
    const m = cs.map(mirror);
    const mdays = fixedDays(m.length, [94, 100, 104]);
    const o = patternOrders('X', m, mdays, detectPatterns(m, mdays), DEFAULT_SR, pp(), 2);
    const [buy] = o['bottom-buy'].get(8)!;
    assert.deepEqual([buy!.side, buy!.entry, buy!.sl, buy!.tp], ['buy', 101, 99.8, 103.72]);
    const [sell] = o['bottom-sell'].get(7)!;
    assert.deepEqual([sell!.side, sell!.entry, sell!.sl, sell!.tp], ['sell', 99.8, 100.4, 94.42]);
    assert.equal(o['top-sell'].size + o['top-buy'].size, 0);
  });

  it('replays into a TP trade', async () => {
    // the replay starts at candle 10: ten quiet candles first
    const long = bars([...Array.from({ length: 10 }, () => TOP[0]!), ...TOP]);
    const ldays = fixedDays(long.length);
    const o = patternOrders('X', long, ldays, detectPatterns(long, ldays), DEFAULT_SR, pp(), 2);
    const trades = await replayOrders('X', { candles: long, digits: 2 }, { warmup: 0 }, (i) => {
      const c = o['top-sell'].get(i);
      return c ? { price: NaN, candidates: c } : null;
    });
    assert.equal(trades.length, 1);
    assert.deepEqual([trades[0]!.side, trades[0]!.entryAt, trades[0]!.exitAt, trades[0]!.result], ['sell', 18 * DAY, 20 * DAY, 'TP']);
  });
});

describe('runBacktest with a pattern strategy', () => {
  // the noisy wave of backtest.test.ts
  function series(n: number, seed = 7): Candle[] {
    let s = seed;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const out: Candle[] = [];
    let price = 1.1;
    for (let i = 0; i < n; i++) {
      const o = price;
      const c = o + Math.sin(i / 25) * 0.0012 + (rnd() - 0.5) * 0.008;
      out.push({ t: i * DAY, o, h: Math.max(o, c) + rnd() * 0.003, l: Math.min(o, c) - rnd() * 0.003, c });
      price = c;
    }
    return out;
  }

  it('keeps each strategy to its own side with sane levels', async () => {
    const data = new Map([['EURUSD', { candles: series(700), digits: 5 }]]);
    const params = { ...DEFAULT_SR, lookback: 120 };
    const side = { 'top-sell': 'sell', 'top-buy': 'buy', 'bottom-buy': 'buy', 'bottom-sell': 'sell' } as const;
    let total = 0;
    for (const strategy of ['top-sell', 'top-buy', 'bottom-buy', 'bottom-sell'] as const) {
      const run = await runBacktest({ data, params, balance: 1000, riskPct: 1, warmup: 120, strategy, pause: async () => {} });
      total += run.trades.length;
      for (const t of run.trades) {
        assert.equal(t.side, side[strategy]);
        if (t.side === 'buy') assert.ok(t.sl < t.entry && t.entry < t.tp);
        else assert.ok(t.sl > t.entry && t.entry > t.tp);
        assert.ok(t.tpPips >= 2 * t.slPips - 0.1, `RR ${t.tpPips}/${t.slPips}`);
      }
    }
    assert.ok(total > 0, 'no pattern trade at all');
  });
});
