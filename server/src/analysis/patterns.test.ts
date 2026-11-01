import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { replayOrders, runBacktest } from './backtest.ts';
import { DEFAULT_PATTERN, detectPatterns, patternOrders, patternParamsFor, patternStats, type DayLines, type PatternParams } from './patterns.ts';
import { DEFAULT_SR } from './sr.ts';
import type { Candle, Line } from './types.ts';

const DAY = 86_400_000;
type Row = [number, number, number, number];
const bars = (rows: Row[]): Candle[] => rows.map(([o, h, l, c], i) => ({ t: i * DAY, o, h, l, c }));
const line = (price: number): Line => ({ price, touches: 2, low: price, high: price });
// fixed lines every morning, ATR 1 (top zone 0.5): support 96, resistance 100, next 106
const fixedDays = (n: number, prices = [96, 100, 106], atr = 1): DayLines[] => Array.from({ length: n }, () => ({ atr, lines: prices.map(line) }));

// Top 1 is the swing high of candle 3 (100.1, known once candle 6 closes), a pullback to
// 98.0 (2.1 ATR), top 2 on candle 7 (99.9, inside the zone from 99.6), the reversal candle
// 8 (low 99.0), then price falls to the target 96 + 0.07 x 4.1 = 96.287.
const TOP: Row[] = [
  [98.0, 98.4, 97.8, 98.2],
  [98.2, 98.6, 98.0, 98.4],
  [98.4, 99.0, 98.3, 98.9],
  [98.9, 100.1, 98.8, 99.2], // top 1
  [99.2, 99.3, 98.5, 98.6],
  [98.6, 98.7, 98.0, 98.3], // the pullback
  [98.3, 99.5, 98.2, 99.4],
  [99.4, 99.9, 99.1, 99.5], // top 2
  [99.5, 99.6, 99.0, 99.1], // reversal candle
  [99.1, 99.2, 98.0, 98.1],
  [98.1, 98.2, 97.0, 97.1],
  [97.1, 97.2, 96.2, 96.4], // target reached
  [96.4, 96.8, 96.3, 96.6],
];
const mirror = (c: Candle): Candle => ({ t: c.t, o: 200 - c.o, h: 200 - c.l, l: 200 - c.h, c: 200 - c.c });
// the line-based model (break on a wick, SL behind a strong candle, TP at the next line,
// stop at the confirmation low) most tests below were written for
// (TOP's pullback low is also a bottom at 1.9 ATR, so the tests ask for 2)
const LINE_MODEL: Partial<PatternParams> = { breakOn: 'wick', slMode: 'candle', tpMode: 'line', entryMode: 'extreme', minDropAtr: 2 };
const pp = (o: Partial<PatternParams> = {}): PatternParams => ({ ...DEFAULT_PATTERN, ...LINE_MODEL, ...o });
const near = (a: number | null | undefined, b: number) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const detect = (rows: Row[], o: Partial<PatternParams> = {}) => {
  const cs = bars(rows);
  return detectPatterns(cs, fixedDays(cs.length), pp(o));
};

describe('detectPatterns', () => {
  it('finds a double top that reaches its target', () => {
    const [e, ...rest] = detect(TOP);
    assert.equal(rest.length, 0);
    assert.equal(e!.kind, 'top');
    assert.equal(e!.first.i, 3);
    assert.equal(e!.second.i, 7);
    near(e!.line, 100.1);
    near(e!.extreme, 100.1);
    near(e!.breakLevel, 100.2);
    near(e!.target, 96.287);
    assert.equal(e!.status, 'success');
    assert.equal(e!.resolvedAt, 11 * DAY);
  });

  it('needs the pullback between the tops', () => {
    assert.equal(detect(TOP, { minDropAtr: 2.5 }).length, 0);
    // a 1.9 ATR pullback with 2 required: candle 7 in the zone is still the same push
    const shallow = TOP.map((r, i): Row => (i === 5 ? [98.6, 98.7, 98.2, 98.3] : r));
    assert.equal(detect(shallow, { minDropAtr: 2 }).length, 0);
    // a higher high before the pullback: candle 3 was no top 1
    const higher = shallow.map((r, i): Row => (i === 7 ? [99.4, 100.3, 99.1, 99.5] : r));
    assert.equal(detect(higher, { minDropAtr: 2 }).length, 0);
  });

  it('marks a later break as fail', () => {
    const [e] = detect([...TOP.slice(0, 9), [99.1, 100.4, 99.0, 100.3]]);
    assert.equal(e!.status, 'fail');
    assert.equal(e!.resolvedAt, 9 * DAY);
  });

  it('marks a top 2 that breaks straight through as fail', () => {
    const rows = TOP.map((r, i): Row => (i === 7 ? [99.4, 100.5, 99.3, 100.4] : r));
    // (the pullback low of 98.0 retested on candle 9 is a double bottom of its own)
    const [e, ...rest] = detect(rows).filter((x) => x.kind === 'top');
    assert.equal(rest.length, 0);
    assert.equal(e!.second.i, 7);
    assert.equal(e!.status, 'fail');
    assert.equal(e!.resolvedAt, 7 * DAY);
    near(e!.extreme, 100.2); // capped at the break level: a broken top 2 is no SL reference
  });

  it('leaves a candle reaching both sides grey', () => {
    const [e] = detect([...TOP.slice(0, 9), [99.1, 100.4, 96.0, 97]]);
    assert.equal(e!.status, 'grey');
    assert.equal(e!.greyBy, 'both');
  });

  it('finds the mirrored double bottom', () => {
    const cs = bars(TOP).map(mirror);
    const [e, ...rest] = detectPatterns(cs, fixedDays(cs.length, [94, 100, 104]), pp());
    assert.equal(rest.length, 0);
    assert.equal(e!.kind, 'bottom');
    near(e!.line, 99.9);
    near(e!.breakLevel, 99.8);
    near(e!.target, 103.713);
    assert.equal(e!.status, 'success');
  });

  it('makes top 2 the top 1 of the next pattern', () => {
    const rows: Row[] = [...TOP.slice(0, 8), [99.5, 99.6, 98.6, 98.7], [98.7, 98.8, 97.8, 97.9], [97.9, 99.6, 97.8, 99.5]];
    assert.deepEqual(detect(rows).map((e) => [e.first.i, e.second.i]), [[3, 7], [7, 10]]);
  });

  it('never looks ahead: earlier patterns are the same on a shorter history', () => {
    const full = detect(TOP);
    const cut = detect(TOP.slice(0, 8));
    assert.deepEqual(cut.map((e) => [e.first, e.second, e.extreme]), full.map((e) => [e.first, e.second, e.extreme]));
  });

  it('counts per kind and year', () => {
    const s = patternStats(detect(TOP));
    assert.deepEqual(s.top, { patterns: 1, success: 1, fail: 0, grey: 0 });
    assert.deepEqual(s.bottom, { patterns: 0, success: 0, fail: 0, grey: 0 });
    assert.equal(s.byYear.get(1970)!.top.patterns, 1);
  });
});

describe('JohnPaul77 model (defaults)', () => {
  const def = (rows: Row[]) => {
    const cs = bars(rows);
    const days = fixedDays(cs.length);
    const q = { ...DEFAULT_PATTERN, minDropAtr: 2 };
    const events = detectPatterns(cs, days, q);
    return { events, orders: patternOrders('X', cs, days, events, DEFAULT_SR, q, 2) };
  };

  it('keeps a top whose wick goes through but closes back below', () => {
    const rows: Row[] = [...TOP.slice(0, 9), [99.1, 100.6, 99.0, 99.2], ...TOP.slice(9)];
    assert.equal(detect(rows)[0]!.status, 'fail'); // on a wick
    const [e] = def(rows).events;
    assert.equal(e!.status, 'success');
  });

  it('sells at the confirmation close with SL 0.6 ATR and TP 2R', () => {
    const { orders } = def(TOP);
    const [sell] = orders['top-sell'].get(9)!;
    assert.deepEqual([sell!.side, sell!.entry, sell!.sl, sell!.tp], ['sell', 99.1, 99.7, 97.9]);
    assert.equal(orders['top-buy'].size, 0);
  });

  it('buys at the close of the candle that closes above top 1', () => {
    const rows: Row[] = [...TOP.slice(0, 8), [99.5, 100.5, 99.4, 100.4], [100.4, 100.6, 100.2, 100.5]];
    const { events, orders } = def(rows);
    assert.equal(events[0]!.status, 'fail');
    const [buy] = orders['top-buy'].get(9)!;
    assert.deepEqual([buy!.side, buy!.entry, buy!.sl, buy!.tp], ['buy', 100.4, 99.8, 101.6]);
    assert.equal(orders['top-sell'].size, 0);
  });
});

describe('patternParamsFor', () => {
  it('gives top-buy its locked settings and leaves the others on the defaults', () => {
    const tb = patternParamsFor('top-buy');
    assert.deepEqual([tb.minDropAtr, tb.slAtr, tb.tpRr, tb.breakOn, tb.slMode, tb.tpMode, tb.orderDays], [1.5, 1.5, 2, 'close', 'fixed', 'rr', 1]);
    assert.deepEqual(patternParamsFor('top-sell'), DEFAULT_PATTERN);
    // a test can still override a locked value
    assert.equal(patternParamsFor('top-buy', { slAtr: 1 }).slAtr, 1);
  });
});

describe('patternOrders', () => {
  const cs = bars(TOP);
  const days = fixedDays(cs.length);
  const events = detectPatterns(cs, days, pp());

  it('places the reversal stop under the reversal candle and the breakout stop above top 1', () => {
    const o = patternOrders('X', cs, days, events, DEFAULT_SR, pp(), 2);
    const [sell] = o['top-sell'].get(9)!;
    assert.deepEqual([sell!.side, sell!.entry, sell!.sl, sell!.tp], ['sell', 99, 100.2, 96.29]);
    const [buy] = o['top-buy'].get(7)!;
    // SL under the zone (100.1 - 0.5 - 0.1), TP before the next line (106 - 0.07 x 5.9)
    assert.deepEqual([buy!.side, buy!.entry, buy!.sl, buy!.tp], ['buy', 100.2, 99.5, 105.59]);
    // the breakout stands on the morning of top 2 and one day after it
    assert.deepEqual([...o['top-buy'].keys()], [7, 8]);
    assert.deepEqual([...o['top-sell'].keys()], [9]);
  });

  it('fills the breakout on a top 2 that breaks straight through', () => {
    const rows = TOP.map((r, i): Row => (i === 7 ? [99.4, 100.5, 99.3, 100.4] : r));
    const b = bars(rows);
    const o = patternOrders('X', b, days, detectPatterns(b, days, pp()), DEFAULT_SR, pp(), 2);
    assert.deepEqual([...o['top-buy'].keys()], [7]);
    assert.equal(o['top-sell'].size, 0);
  });

  it('puts the SL behind the strong candle, as Breakout JohnPaul77 does', () => {
    // candle 8 (body 0.4 of 0.6, 0.4 ATR) is the nearest strong bearish candle above 99.0
    const wide = { ...DEFAULT_SR, slMaxRiskAtr: 1 };
    const [sell] = patternOrders('X', cs, days, events, wide, pp(), 2)['top-sell'].get(9)!;
    assert.deepEqual([sell!.sl, sell!.slFrom], [99.7, 'candle']);
    // at the default 0.6 ATR that SL is too wide: back to the pattern SL above the tops
    const [def] = patternOrders('X', cs, days, events, DEFAULT_SR, pp(), 2)['top-sell'].get(9)!;
    assert.deepEqual([def!.sl, def!.slFrom], [100.2, 'ladder']);
    // the mirror for the bottom: under the strong bullish candle
    const m = cs.map(mirror);
    const mdays = fixedDays(m.length, [94, 100, 104]);
    const [buy] = patternOrders('X', m, mdays, detectPatterns(m, mdays, pp()), wide, pp(), 2)['bottom-buy'].get(9)!;
    assert.deepEqual([buy!.sl, buy!.slFrom], [100.3, 'candle']);
  });

  it('withdraws the breakout once the reversal target is reached', () => {
    // no reversal order (min RR 3): the breakout stays until candle 11 hits 96.287
    const o = patternOrders('X', cs, days, events, DEFAULT_SR, pp({ orderDays: 10, minRr: 3 }), 2);
    assert.deepEqual([...o['top-buy'].keys()], [7, 8, 9, 10, 11]);
    assert.equal(o['top-sell'].size, 0);
  });

  it('takes a farther TP line with minTargetAtr', () => {
    const far = fixedDays(cs.length, [93, 96, 100, 103, 106]);
    const o = patternOrders('X', cs, far, detectPatterns(cs, far, pp({ minTargetAtr: 5 })), DEFAULT_SR, pp({ minTargetAtr: 5, minRr: 1 }), 2);
    // 96 and 103 are within 5 ATR: the TPs come from 93 (93 + 0.07 x 7.1) and 106
    assert.equal(o['top-sell'].get(9)![0]!.tp, 93.5);
    assert.equal(o['top-buy'].get(7)![0]!.tp, 105.59);
  });

  it('withdraws the other branch once one entry is reached', () => {
    const o = patternOrders('X', cs, days, events, DEFAULT_SR, pp({ orderDays: 5 }), 2);
    // the reversal fills on candle 9, so the breakout is not placed after it
    assert.deepEqual([...o['top-buy'].keys()], [7, 8, 9]);
    assert.deepEqual([...o['top-sell'].keys()], [9]);
  });

  it('enters near the close in close mode and skips a small RR', () => {
    const close = patternOrders('X', cs, days, events, DEFAULT_SR, pp({ entryMode: 'close' }), 2);
    assert.equal(close['top-sell'].get(9)![0]!.entry, 99.1);
    const strict = patternOrders('X', cs, days, events, DEFAULT_SR, pp({ minRr: 3 }), 2);
    assert.equal(strict['top-sell'].size, 0);
  });

  it('mirrors the orders for bottoms', () => {
    const m = cs.map(mirror);
    const mdays = fixedDays(m.length, [94, 100, 104]);
    const o = patternOrders('X', m, mdays, detectPatterns(m, mdays, pp()), DEFAULT_SR, pp(), 2);
    const [buy] = o['bottom-buy'].get(9)!;
    assert.deepEqual([buy!.side, buy!.entry, buy!.sl, buy!.tp], ['buy', 101, 99.8, 103.71]);
    const [sell] = o['bottom-sell'].get(7)!;
    assert.deepEqual([sell!.side, sell!.entry, sell!.sl, sell!.tp], ['sell', 99.8, 100.5, 94.41]);
    assert.equal(o['top-sell'].size + o['top-buy'].size, 0);
  });

  it('replays into a TP trade', async () => {
    // the replay starts at candle 10: ten quiet candles first
    const long = bars([...Array.from({ length: 10 }, () => TOP[0]!), ...TOP]);
    const ldays = fixedDays(long.length);
    const o = patternOrders('X', long, ldays, detectPatterns(long, ldays, pp()), DEFAULT_SR, pp(), 2);
    const trades = await replayOrders('X', { candles: long, digits: 2 }, { warmup: 0 }, (i) => {
      const c = o['top-sell'].get(i);
      return c ? { price: NaN, candidates: c } : null;
    });
    assert.equal(trades.length, 1);
    assert.deepEqual([trades[0]!.side, trades[0]!.entryAt, trades[0]!.exitAt, trades[0]!.result], ['sell', 19 * DAY, 21 * DAY, 'TP']);
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
        // prices are rounded to the digits, so a 2R TP can come out a rounding step short
        assert.ok(t.tpPips >= 2 * t.slPips - 0.25, `RR ${t.tpPips}/${t.slPips}`);
      }
    }
    assert.ok(total > 0, 'no pattern trade at all');
  });
});
