// Backtest report of the double top / bottom strategies (analysis/patterns.ts), for the
// terminal. Reads a candle dump (the dev:memory --data format) and prints:
//   1. the pattern statistics: patterns per pair and per year, how many went the reversal
//      way (success), the breakout way (fail) or neither (grey), tops and bottoms apart;
//   2. per strategy and order variant: trades, win rate, expectancy, profit factor, max
//      consecutive losses, trades per year and the result per era, gross and net of costs;
//      the trades go to <out>/<strategy>-<variant>.csv in the backtest CSV format.
//
//   node scripts/pattern-report.ts --data dump.json [--from 2004-01-01] [--to 2026-10-31]
//        [--out dir] [--pairs EURUSD,GBPUSD] [--json results.json]
// Pattern settings: --minDropAtr 1 --breakoutBufferAtr 0.1 --slBufferAtr 0.1 --minRr 2 --minTargetAtr 0
//                   --slMode candle|pattern --slMaxRiskAtr 0.6 (candle SL wider than this falls back)
// The lines are always the locked SR_LINES.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { compound, DEFAULT_COSTS, patternsOf, replayOrders, withCosts, type RawTrade, type ReplayOptions } from '../src/analysis/backtest.ts';
import { overall, pairStats, tradesCsv } from '../src/analysis/backtestStats.ts';
import { DEFAULT_PATTERN, detectPatterns, PATTERN_STRATEGIES, patternOrders, patternStats, type DayLines, type PatternCount, type PatternEvent, type PatternParams } from '../src/analysis/patterns.ts';
import { DEFAULT_SR } from '../src/analysis/sr.ts';
import type { Candle } from '../src/analysis/types.ts';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    from: { type: 'string', default: '2004-01-01' },
    to: { type: 'string' },
    out: { type: 'string', default: 'pattern-report' },
    pairs: { type: 'string' },
    json: { type: 'string' },
    minDropAtr: { type: 'string' },
    breakoutBufferAtr: { type: 'string' },
    slBufferAtr: { type: 'string' },
    minRr: { type: 'string' },
    minTargetAtr: { type: 'string' },
    slMode: { type: 'string' },
    slMaxRiskAtr: { type: 'string' },
  },
});
if (!values.data) throw new Error('--data <dump.json> is required');

const pp: PatternParams = { ...DEFAULT_PATTERN };
for (const k of ['minDropAtr', 'breakoutBufferAtr', 'slBufferAtr', 'minRr', 'minTargetAtr'] as const) if (values[k] !== undefined) pp[k] = Number(values[k]);
if (values.slMode === 'candle' || values.slMode === 'pattern') pp.slMode = values.slMode;

type Dump = Record<string, { digits: number; candles: Candle[] }>;
const dump: Dump = JSON.parse(readFileSync(values.data, 'utf8'));
const pairs = Object.keys(dump).filter((s) => !values.pairs || values.pairs.split(',').includes(s)).sort();
// candle SL settings of Breakout JohnPaul77; only slMaxRiskAtr can be tried from here
const p = { ...DEFAULT_SR, ...(values.slMaxRiskAtr ? { slMaxRiskAtr: Number(values.slMaxRiskAtr) } : {}) };
const opts: ReplayOptions = {
  warmup: p.lookback,
  from: Date.parse(`${values.from}T00:00:00Z`),
  ...(values.to ? { to: Date.parse(`${values.to}T23:59:59Z`) } : {}),
};

const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(0)}%` : '-');
const row = (cells: (string | number)[], widths: number[]) => cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]!) : String(c).padStart(widths[i]!))).join(' ');
const decided = (c: PatternCount) => c.success + c.fail;

// --- lines, once per pair (the slow part) -------------------------------------------
const perPair = new Map<string, { cs: Candle[]; digits: number; days: DayLines[]; events: PatternEvent[] }>();
const t0 = Date.now();
for (const sym of pairs) {
  const d = dump[sym]!;
  const r = await patternsOf(sym, { candles: d.candles, digits: d.digits }, p, pp, opts);
  perPair.set(sym, { cs: d.candles, digits: d.digits, days: r.days, events: r.events });
  process.stderr.write(`${sym} ${r.events.length} patterns (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
}

// --- 1. pattern statistics ------------------------------------------------------------
console.log(`\n== Pattern statistics ${values.from} .. ${values.to ?? 'end'}  (minDrop ${pp.minDropAtr} ATR, breakout buffer ${pp.breakoutBufferAtr} ATR, resolve ${pp.resolveBars} bars) ==`);
console.log('success = reached the reversal target first; fail = traded past the tops/bottoms first; rev% = success / (success + fail)\n');
const W = [8, 6, 6, 6, 6, 6, 7, 6, 6, 6, 6, 6];
console.log(row(['pair', 'tops', 'succ', 'fail', 'grey', 'rev%', '| bots', 'succ', 'fail', 'grey', 'rev%', 'yrs'], W));
const all: PatternEvent[] = [];
for (const sym of pairs) {
  const { events, cs } = perPair.get(sym)!;
  all.push(...events);
  const s = patternStats(events);
  const first = cs.find((c) => c.t >= opts.from!)?.t ?? cs[0]!.t;
  const yrs = (cs[cs.length - 1]!.t - Math.max(first, cs[Math.min(p.lookback, cs.length - 1)]!.t)) / (365.25 * 86_400_000);
  console.log(row([sym, s.top.patterns, s.top.success, s.top.fail, s.top.grey, pct(s.top.success, decided(s.top)), `| ${s.bottom.patterns}`, s.bottom.success, s.bottom.fail, s.bottom.grey, pct(s.bottom.success, decided(s.bottom)), yrs.toFixed(1)], W));
}
const tot = patternStats(all);
console.log(row(['ALL', tot.top.patterns, tot.top.success, tot.top.fail, tot.top.grey, pct(tot.top.success, decided(tot.top)), `| ${tot.bottom.patterns}`, tot.bottom.success, tot.bottom.fail, tot.bottom.grey, pct(tot.bottom.success, decided(tot.bottom)), ''], W));
const greyBy = (kind: string) => Object.entries(all.filter((e) => e.kind === kind && e.status === 'grey').reduce<Record<string, number>>((m, e) => ((m[e.greyBy!] = (m[e.greyBy!] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`grey tops: ${greyBy('top')}; grey bottoms: ${greyBy('bottom')}`);

// How far the reversal target lies decides how much a pattern means: with the next line
// ~0.7 ATR away most patterns are decided by the very next candle.
console.log('\nTarget distance (all pairs): minTargetAtr = the TP line at least this x ATR from the pattern line');
const WT = [10, 7, 7, 7, 9, 10, 7];
console.log(row(['minTarget', 'tops', 'rev%', 'bots', 'rev%', 'next-day', 'grey'], WT));
for (const mt of [0, 1, 1.5, 2, 3]) {
  const q = { ...pp, minTargetAtr: mt };
  const es: PatternEvent[] = [];
  let nextDay = 0;
  for (const sym of pairs) {
    const { cs, days } = perPair.get(sym)!;
    for (const e of detectPatterns(cs, days, q).filter((e) => e.second.t >= opts.from! && (opts.to === undefined || e.second.t <= opts.to))) {
      es.push(e);
      if (e.resolvedAt === cs[e.second.i + 1]?.t) nextDay++;
    }
  }
  const st = patternStats(es);
  console.log(row([mt, st.top.patterns, pct(st.top.success, decided(st.top)), st.bottom.patterns, pct(st.bottom.success, decided(st.bottom)), pct(nextDay, es.length), pct(st.top.grey + st.bottom.grey, es.length)], WT));
}

console.log('\nPer year (all pairs)');
const WY = [6, 6, 6, 6, 7, 6, 6, 6];
console.log(row(['year', 'tops', 'succ', 'fail', 'rev%', '| bots', 'succ', 'fail', 'rev%'], [...WY, 6]));
for (const [y, r] of [...tot.byYear].sort((a, b) => a[0] - b[0])) {
  console.log(row([y, r.top.patterns, r.top.success, r.top.fail, pct(r.top.success, decided(r.top)), `| ${r.bottom.patterns}`, r.bottom.success, r.bottom.fail, pct(r.bottom.success, decided(r.bottom))], [...WY, 6]));
}

// --- 2. the four strategies ---------------------------------------------------------
const variants: { name: string; pp: PatternParams }[] = [
  { name: 'low-1d', pp: { ...pp, entryMode: 'extreme', orderDays: 1 } },
  { name: 'close-1d', pp: { ...pp, entryMode: 'close', orderDays: 1 } },
  { name: 'low-5d', pp: { ...pp, entryMode: 'extreme', orderDays: 5 } },
  { name: 'low-10d', pp: { ...pp, entryMode: 'extreme', orderDays: 10 } },
];
const ERAS: [string, number, number][] = [
  ['2004-09', 2004, 2009],
  ['2010-14', 2010, 2014],
  ['2015-19', 2015, 2019],
  ['2020-26', 2020, 2026],
];
mkdirSync(values.out!, { recursive: true });
const lastT = Math.max(...pairs.map((sym) => perPair.get(sym)!.cs.at(-1)!.t));
const testYears = (Math.min(lastT, opts.to ?? Infinity) - opts.from!) / (365.25 * 86_400_000);
const results: Record<string, unknown> = {};
const WS = [24, 6, 6, 7, 7, 6, 6, 6, 6, 9, 9, 9, 9];
console.log(`\n== Strategies (min RR ${pp.minRr}, SL buffer ${pp.slBufferAtr} ATR, min target ${pp.minTargetAtr} ATR, SL ${pp.slMode} (max ${p.slMaxRiskAtr} ATR); risk 1%, compounding; net = after Maxrich spreads + USD 10/lot) ==`);
console.log('"low" = reversal stop at the confirmation candle low/high, "close" = at its close; Nd = order stays N days. Breakout branches ignore the entry mode.\n');
console.log(row(['strategy / variant', 'trades', 'win%', 'expR', 'netR', 'PF_R', 'netPF', 'maxL', '/yr', ...ERAS.map((e) => e[0]), 'candSL'], [...WS, 7]));
for (const v of variants) {
  const raw: Record<string, RawTrade[]> = Object.fromEntries(PATTERN_STRATEGIES.map((s) => [s, []]));
  const candleSl: Record<string, Set<string>> = Object.fromEntries(PATTERN_STRATEGIES.map((s) => [s, new Set()]));
  const placed: Record<string, Set<string>> = Object.fromEntries(PATTERN_STRATEGIES.map((s) => [s, new Set()]));
  for (const sym of pairs) {
    const { cs, digits, days } = perPair.get(sym)!;
    const events = detectPatterns(cs, days, v.pp).filter((e) => e.second.t >= opts.from! && (opts.to === undefined || e.second.t <= opts.to));
    const orders = patternOrders(sym, cs, days, events, p, v.pp, digits);
    for (const s of PATTERN_STRATEGIES) {
      for (const list of orders[s].values()) {
        for (const c of list) {
          placed[s]!.add(c.id);
          if (c.slFrom === 'candle') candleSl[s]!.add(c.id);
        }
      }
      const tr = await replayOrders(sym, { candles: cs, digits }, opts, (i) => {
        const c = orders[s].get(i);
        return c ? { price: NaN, candidates: c } : null;
      });
      raw[s]!.push(...tr.filter((t) => t.result !== 'Open'));
    }
  }
  for (const s of PATTERN_STRATEGIES) {
    // breakout branches do not depend on the entry mode
    if (v.name === 'close-1d' && (s === 'top-buy' || s === 'bottom-sell')) continue;
    const gross = compound(raw[s]!, 10_000, 1);
    const net = compound(withCosts(raw[s]!, DEFAULT_COSTS), 10_000, 1);
    const o = overall(gross, 10_000);
    const on = overall(net, 10_000);
    // profit factor in R: in pips it would weigh gold and JPY pairs differently
    const pfR = (ts: RawTrade[]) => {
      const loss = -ts.reduce((x, t) => x + Math.min(t.r, 0), 0);
      return loss > 0 ? (ts.reduce((x, t) => x + Math.max(t.r, 0), 0) / loss).toFixed(2) : '-';
    };
    const era = ERAS.map(([, a, b]) => {
      const ts = withCosts(raw[s]!, DEFAULT_COSTS).filter((t) => {
        const y = new Date(t.entryAt).getUTCFullYear();
        return y >= a && y <= b;
      });
      return ts.length ? `${ts.length}:${(ts.reduce((x, t) => x + t.r, 0) / ts.length).toFixed(2)}` : '-';
    });
    console.log(row([`${s} / ${v.name}`, `${o.trades}`, pct(o.wins, o.trades), o.expectancyR ?? '-', on.expectancyR ?? '-', pfR(raw[s]!), pfR(withCosts(raw[s]!, DEFAULT_COSTS)), on.consecutiveLoss.byTrade.count, (o.trades / testYears).toFixed(1), ...era, pct(candleSl[s]!.size, placed[s]!.size)], [...WS, 7]));
    writeFileSync(`${values.out}/${s}-${v.name}.csv`, tradesCsv(net, true));
    results[`${s}/${v.name}`] = { gross: o, net: on, perPair: pairs.map((sym) => pairStats(sym, net.filter((t) => t.symbol === sym), 10_000)) };
  }
}
console.log('\nexpR / netR = expectancy in R gross / after costs; maxL = most losses in a row (net); /yr = trades per year over the whole test, all pairs; era cells: trades:net expectancy R of trades entered in that era; candSL = share of placed orders whose SL is the strong candle');
if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 1));
