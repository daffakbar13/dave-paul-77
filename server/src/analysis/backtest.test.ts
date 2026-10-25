import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compound, coverageOf, DEFAULT_COSTS, defaultSpreadPips, FALLBACK_SPREAD_PIPS, fillDay, replaySymbol, runBacktest, tierOf, withCosts, withoutPairs, type RawTrade } from './backtest.ts';
import { DEFAULT_SR, pipSize, roundTo } from './sr.ts';
import type { Candle } from './types.ts';

const DAY = 86_400_000;
const T0 = Date.parse('2020-01-01T00:00:00Z');

// deterministic noisy random walk around a slow wave, so swings and ranges exist
function series(n: number, seed = 7, start = 1.1): Candle[] {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 25) * 0.0012;
    const o = price;
    const c = o + drift + (rnd() - 0.5) * 0.008;
    const h = Math.max(o, c) + rnd() * 0.003;
    const l = Math.min(o, c) - rnd() * 0.003;
    out.push({ t: T0 + i * DAY, o, h, l, c });
    price = c;
  }
  return out;
}

const params = { ...DEFAULT_SR, lookback: 120 };
const opts = { warmup: 120 };

const raw = (r: Partial<RawTrade>): RawTrade => ({
  symbol: 'EURUSD', side: 'buy', entryAt: T0, exitAt: T0 + DAY, entry: 1.1, tp: 1.102, sl: 1.099, result: 'TP',
  tpPips: 20, slPips: 10, pips: 20, r: 2, ambiguous: false, digits: 5, ...r,
});

describe('replaySymbol', async () => {
  const candles = series(600);
  const trades = await replaySymbol('EURUSD', { candles, digits: 5 }, params, opts);

  it('produces trades with consistent levels and results', () => {
    assert.ok(trades.length > 20, `only ${trades.length} trades`);
    for (const t of trades) {
      if (t.side === 'buy') assert.ok(t.sl < t.entry && t.entry < t.tp);
      else assert.ok(t.sl > t.entry && t.entry > t.tp);
      assert.ok(t.slPips > 0 && t.tpPips > 0);
      if (t.result === 'Open') {
        assert.equal(t.exitAt, null);
        assert.equal(t.pips, 0);
      } else {
        assert.ok(t.exitAt! >= t.entryAt);
        assert.equal(t.result === 'TP' ? t.pips > 0 : t.pips < 0, true);
        assert.equal(t.r, t.result === 'TP' ? Math.round((t.tpPips / t.slPips) * 1e4) / 1e4 : -1);
      }
    }
  });

  it('never has the same level open twice', () => {
    const open = new Map<string, RawTrade[]>();
    for (const t of trades) {
      const key = `${t.side}:${t.entry}`;
      const list = open.get(key) ?? [];
      for (const o of list) assert.ok(o.exitAt !== null && o.exitAt < t.entryAt, `level ${key} placed again while open`);
      open.set(key, [...list, t]);
    }
  });

  it('has no look-ahead: changing later candles does not change earlier trades', async () => {
    const cut = 450;
    const altered = candles.map((c, i) => (i < cut ? c : { ...c, h: c.h + 0.02, l: c.l - 0.02, c: c.c + 0.01 }));
    const a = await replaySymbol('EURUSD', { candles: altered, digits: 5 }, params, opts);
    const key = (t: RawTrade) => `${t.entryAt}|${t.side}|${t.entry}|${t.sl}|${t.tp}`;
    const before = (list: RawTrade[]) => list.filter((t) => t.entryAt < candles[cut]!.t).map(key);
    assert.deepEqual(before(a), before(trades));
  });

  it('respects from/to', async () => {
    const from = candles[300]!.t;
    const to = candles[400]!.t;
    const part = await replaySymbol('EURUSD', { candles, digits: 5 }, params, { ...opts, from, to });
    assert.ok(part.length > 0);
    assert.ok(part.every((t) => t.entryAt >= from && t.entryAt <= to));
  });

  it('trades are not all losers: the fill day is not read as an automatic SL', () => {
    const closed = trades.filter((t) => t.result !== 'Open');
    const wins = closed.filter((t) => t.result === 'TP').length;
    assert.ok(wins / closed.length > 0.15, `win share ${wins}/${closed.length}`);
  });
});

describe('fillDay', () => {
  const c = (o: number, l: number, h: number, cl: number) => ({ t: T0, o, h, l, c: cl });

  it('does not fill when the entry is never reached', () => {
    assert.equal(fillDay('buy', c(1.0, 0.99, 1.005, 1.0), 1.01, 1.005, 1.03, true), null);
    assert.equal(fillDay('sell', c(1.0, 0.995, 1.02, 1.0), 0.99, 0.995, 0.97, false), null);
  });

  it('only counts SL and TP after the fill', () => {
    // rising candle: the low comes first, so the stop below the entry is not touched yet
    // and the close stays above it; the same candle falling reaches the entry first
    const candle = c(1.0, 0.99, 1.03, 1.02);
    assert.deepEqual(fillDay('buy', candle, 1.01, 1.005, 1.05, true), { exit: null });
    assert.deepEqual(fillDay('buy', candle, 1.01, 1.005, 1.05, false), { exit: 'SL' });
  });

  it('a TP inside the rise after the fill wins', () => {
    assert.deepEqual(fillDay('buy', c(1.0, 0.99, 1.03, 1.02), 1.01, 1.005, 1.02, true), { exit: 'TP' });
  });

  it('works mirrored for a sell stop', () => {
    // falling candle (open-high-low-close): the rise to 1.01 is before the fill, so the
    // stop at 0.995 is not met; the drop through 0.99 reaches the TP at 0.975
    assert.deepEqual(fillDay('sell', c(1.0, 0.97, 1.01, 0.98), 0.99, 0.995, 0.975, false), { exit: 'TP' });
    // rising candle (open-low-high-close): the drop fills it, the rise back to 1.01 hits the stop
    assert.deepEqual(fillDay('sell', c(1.0, 0.985, 1.01, 1.005), 0.99, 0.995, 0.96, true), { exit: 'SL' });
  });

  it('a candle opening beyond a buy entry fills at the open', () => {
    assert.deepEqual(fillDay('buy', c(1.02, 1.015, 1.04, 1.03), 1.01, 1.0, 1.05, true), { exit: null });
  });
});

describe('compound', () => {
  it('sizes each trade on the balance of earlier closes and compounds', () => {
    const t = compound(
      [
        raw({ entryAt: T0, exitAt: T0 + DAY, r: 2 }),
        raw({ entryAt: T0 + 2 * DAY, exitAt: T0 + 3 * DAY, r: -1, result: 'SL', entry: 1.2 }),
        raw({ entryAt: T0 + 5 * DAY, exitAt: T0 + 6 * DAY, r: 2, entry: 1.3 }),
      ],
      1000,
      1,
    );
    assert.equal(t[0]!.balanceBefore, 1000);
    assert.equal(t[0]!.riskMoney, 10);
    assert.equal(t[0]!.profit, 20);
    assert.equal(t[1]!.balanceBefore, 1020);
    assert.equal(t[1]!.profit, -10.2);
    assert.equal(t[2]!.balanceBefore, 1009.8);
    assert.equal(t[2]!.riskMoney, 10.1);
  });

  it('a trade closing on the fill day of another is not counted yet', () => {
    const t = compound(
      [raw({ entryAt: T0, exitAt: T0 + DAY, r: 2 }), raw({ entryAt: T0 + DAY, exitAt: T0 + 2 * DAY, entry: 1.2 })],
      1000,
      1,
    );
    assert.equal(t[1]!.balanceBefore, 1000);
  });

  it('open trades risk money but add no profit', () => {
    const t = compound([raw({ result: 'Open', exitAt: null, pips: 0, r: 0 })], 1000, 2);
    assert.equal(t[0]!.riskMoney, 20);
    assert.equal(t[0]!.profit, 0);
  });

  it('never risks a negative balance', () => {
    const t = compound([raw({ r: -1, result: 'SL' }), raw({ entryAt: T0 + 5 * DAY, exitAt: T0 + 6 * DAY, entry: 1.2 })], 0, 1);
    assert.equal(t[1]!.riskMoney, 0);
  });
});

describe('withoutPairs', async () => {
  const data = new Map([
    ['AAAUSD', { candles: series(700, 7), digits: 5 }],
    ['BBBUSD', { candles: series(700, 11, 1.3), digits: 5 }],
    ['CCCUSD', { candles: series(700, 23, 0.9), digits: 5 }],
  ]);
  const input = { params, balance: 10_000, riskPct: 1, warmup: 120, pause: async () => {} };
  const full = await runBacktest({ ...input, data });

  it('equals a run that never had the excluded pairs', async () => {
    const only = await runBacktest({ ...input, data: new Map([['AAAUSD', data.get('AAAUSD')!]]) });
    const cut = withoutPairs(full.trades, new Set(['BBBUSD', 'CCCUSD']), 10_000, 1);
    assert.ok(only.trades.length > 0);
    assert.deepEqual(cut, only.trades);
  });

  it('resizes the pairs that stay instead of only filtering them', () => {
    const cut = withoutPairs(full.trades, new Set(['BBBUSD']), 10_000, 1);
    assert.ok(cut.every((t) => t.symbol !== 'BBBUSD'));
    const filtered = full.trades.filter((t) => t.symbol !== 'BBBUSD');
    assert.equal(cut.length, filtered.length);
    assert.notDeepEqual(cut.map((t) => t.profit), filtered.map((t) => t.profit));
  });

  it('returns the trades untouched when nothing is excluded', () => {
    assert.equal(withoutPairs(full.trades, new Set(), 10_000, 1), full.trades);
  });
});

describe('coverage', () => {
  it('names the tier by tested years', () => {
    assert.equal(tierOf(0), 'none');
    assert.equal(tierOf(1.5), 'short');
    assert.equal(tierOf(2), 'min');
    assert.equal(tierOf(5), 'good');
    assert.equal(tierOf(10), 'better');
    assert.equal(tierOf(20), 'perfect');
  });

  it('subtracts holes from the covered years and lists them', () => {
    const cs = series(120 + 1000);
    const hole = cs.map((c, i) => (i >= 700 && i < 900 ? null : c)).filter((c): c is Candle => c !== null);
    const c = coverageOf('X', hole, { warmup: 120 });
    assert.equal(c.gaps.length, 1);
    assert.equal(c.gaps[0]!.days, 201);
    assert.equal(c.gapDays, 201);
    const whole = coverageOf('X', cs, { warmup: 120 });
    assert.ok(whole.gaps.length === 0 && whole.gapDays === 0);
    assert.ok(Math.abs(whole.years - c.years - 200 / 365.25) < 0.02);
  });

  it('counts years after the warm-up', () => {
    const c = coverageOf('X', series(120 + 365), { warmup: 120 });
    assert.ok(Math.abs(c.years - 1) < 0.02);
    assert.equal(c.tier, 'short');
  });
});

describe('runBacktest', () => {
  it('runs several symbols and reports progress', async () => {
    const data = new Map([['AAA', { candles: series(400, 3), digits: 5 }], ['BBB', { candles: series(400, 9, 1.3), digits: 5 }]]);
    const seen: number[] = [];
    const run = await runBacktest({ data, params, balance: 6000, riskPct: 1, warmup: 120, onProgress: (d) => seen.push(d) });
    assert.deepEqual(seen, [1, 2]);
    assert.equal(run.coverage.length, 2);
    assert.ok(new Set(run.trades.map((t) => t.symbol)).size === 2);
    assert.ok(run.trades.every((t) => t.result !== 'Open'), 'trades still open at the end are left out');
  });
});

describe('withCosts', () => {
  const costs = { ...DEFAULT_COSTS };

  it('takes spread + slippage off pips and R of closed trades', () => {
    const [tp, sl] = withCosts([raw({}), raw({ result: 'SL', pips: -10, r: -1 })], { ...costs, slippagePips: 0.5 });
    // EURUSD spread 1.0 + 0.5 slippage over a 10-pip SL
    assert.equal(tp!.pips, 18.5);
    assert.equal(tp!.r, 1.85);
    assert.equal(sl!.pips, -11.5);
    assert.equal(sl!.r, -1.15);
    assert.equal(tp!.result, 'TP');
  });

  it('leaves the trades as they are when off', () => {
    const list = [raw({})];
    assert.equal(withCosts(list, { ...costs, enabled: false }), list);
  });

  it('a pair override wins over the default', () => {
    assert.equal(withCosts([raw({})], { ...costs, spreadPips: { EURUSD: 3 } })[0]!.pips, 17);
  });

  it('gold default is $0.25 whatever the digits', () => {
    assert.equal(defaultSpreadPips('XAUUSD', 2) * pipSize(2), 0.25);
    assert.equal(roundTo(defaultSpreadPips('XAUUSD', 3) * pipSize(3), 6), 0.25);
    assert.equal(defaultSpreadPips('GBPJPY', 3), 2.5);
    assert.equal(defaultSpreadPips('EURUSDm', 5), 1.0);
    assert.equal(defaultSpreadPips('XYZABC', 5), FALLBACK_SPREAD_PIPS);
  });
});
