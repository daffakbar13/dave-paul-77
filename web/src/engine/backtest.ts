// Day-by-day replay of the order engine over stored D1 candles.
//
// Every trading day the engine analyses only the candles that closed before that day, which
// gives the same buy/sell stop orders the live app would have placed that morning. Those
// orders live for that day only ("Execute every day"). A fill opens a trade that then runs
// until its SL or TP is touched; a pair holds at most one position per side (buy / sell).
// Money is added afterwards (`compound`): every trade risks riskPct of the balance on the
// day it fills, and the balance only counts trades that closed on an earlier day.
import type { BtTrade } from './backtestStats.ts';
import { analyze, pipSize, roundTo } from './sr.ts';
import type { Candle, Side, SrParams, SymbolData } from './types.ts';

const MIN_RISK_PIPS = 1e-6;

// A trade before money is applied.
export type RawTrade = Omit<BtTrade, 'riskMoney' | 'profit' | 'balanceBefore' | 'r' | 'pips'> & { pips: number; r: number };

export type ReplayOptions = {
  warmup: number; // closed candles an analysis needs before the first test day
  from?: number; // first day tested (ms); earlier days only serve as history
  to?: number; // last day tested (ms)
};

type Exit = { result: 'TP' | 'SL'; both: boolean };

// The two ways one D1 candle can have been traversed. Rising candles are taken as
// open-low-high-close, falling ones as open-high-low-close; the other order is what the
// result is compared against to flag how much depends on that assumption.
const pathOf = (c: Candle, rising: boolean): number[] => (rising ? [c.o, c.l, c.h, c.c] : [c.o, c.h, c.l, c.c]);

// Walks a candle's price path for a stop order that is not filled yet: the entry must be
// reached first, only then do SL and TP count. A candle that opens beyond the entry fills
// at the open. Returns null when the order does not fill, else how the trade ended that day.
export function fillDay(side: Side, c: Candle, entry: number, sl: number, tp: number, rising: boolean): { exit: 'TP' | 'SL' | null } | null {
  const path = pathOf(c, rising);
  let filled = side === 'buy' ? c.o >= entry : c.o <= entry;
  let at = path[0]!;
  for (let k = 1; k < path.length; k++) {
    const to = path[k]!;
    const between = (x: number) => (at <= to ? x >= at && x <= to : x <= at && x >= to);
    if (!filled) {
      if (!between(entry)) {
        at = to;
        continue;
      }
      filled = true;
      at = entry;
    }
    const slIn = between(sl);
    const tpIn = between(tp);
    if (slIn || tpIn) {
      // the level nearer to where the segment starts is met first
      if (slIn && tpIn) return { exit: Math.abs(sl - at) <= Math.abs(tp - at) ? 'SL' : 'TP' };
      return { exit: slIn ? 'SL' : 'TP' };
    }
    at = to;
  }
  return filled ? { exit: null } : null;
}

// Which exit a candle reaches for a trade that was already open. A candle that reaches
// both is counted as SL: a D1 candle cannot tell which came first, so the result is a
// floor rather than a best case.
function exitIn(side: Side, c: Candle, sl: number, tp: number): Exit | null {
  const slHit = side === 'buy' ? c.l <= sl : c.h >= sl;
  const tpHit = side === 'buy' ? c.h >= tp : c.l <= tp;
  if (slHit) return { result: 'SL', both: tpHit };
  if (tpHit) return { result: 'TP', both: false };
  return null;
}

// Orders must have sane geometry; one with SL on its entry (no risk) is dropped.
function usable(side: Side, entry: number, sl: number, tp: number, ref: number, pip: number): boolean {
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp)) return false;
  if (Math.abs(entry - sl) / pip < MIN_RISK_PIPS) return false;
  if (side === 'buy') return sl < entry && tp > entry && entry > ref;
  return sl > entry && tp < entry && entry < ref;
}

// Lets the event loop run after ~10 ms of work. A 22-year replay of one pair is a second of
// CPU on a laptop and many times that on a small shared host; without these pauses the
// server stops answering (health checks, the page's polling) until the pair is done.
export function makePause(everyMs = 10): () => Promise<void> {
  let last = Date.now();
  // setImmediate in Node; browsers have only setTimeout
  const immediate = (globalThis as { setImmediate?: (f: () => void) => unknown }).setImmediate;
  const later = (f: () => void) => (immediate ? immediate(f) : setTimeout(f, 0));
  return async () => {
    if (Date.now() - last < everyMs) return;
    await new Promise<void>((resolve) => later(resolve));
    last = Date.now();
  };
}

export async function replaySymbol(symbol: string, data: SymbolData, p: SrParams, opts: ReplayOptions, pause?: () => Promise<void>): Promise<RawTrade[]> {
  const cs = data.candles;
  const pip = pipSize(data.digits);
  const trades: RawTrade[] = [];
  const open = new Map<string, RawTrade>();
  const start = Math.max(opts.warmup, 10);

  for (let i = start; i < cs.length; i++) {
    const day = cs[i]!;
    if (opts.to !== undefined && day.t > opts.to) break;

    // One position per pair and side. The day's orders are placed in the morning, so a side
    // that is open now (even if it closes today) gets no new order today, and neither does a
    // side that fills earlier today. The other side may still be placed while this one runs.
    const taken = new Set<Side>([...open.values()].map((t) => t.side));

    // trades opened on an earlier day run on
    for (const [id, tr] of open) {
      const x = exitIn(tr.side, day, tr.sl, tr.tp);
      if (!x) continue;
      tr.result = x.result;
      tr.exitAt = day.t;
      tr.pips = roundTo(x.result === 'TP' ? tr.tpPips : -tr.slPips, 2);
      tr.r = roundTo(x.result === 'TP' ? tr.tpPips / tr.slPips : -1, 4);
      tr.ambiguous = x.both;
      open.delete(id);
    }

    if (opts.from !== undefined && day.t < opts.from) continue;

    const a = analyze(symbol, cs.slice(Math.max(0, i - p.lookback), i), p, data.digits, undefined, data.inputs);
    if (pause) await pause();
    // the stop nearest the open is reached first, so it takes the side's one position
    const byReach = [...a.candidates].sort((x, y) => Math.abs((x.entry ?? Infinity) - day.o) - Math.abs((y.entry ?? Infinity) - day.o));
    for (const c of byReach) {
      if (c.skipped || c.entry === undefined || c.sl === undefined || c.tp === undefined) continue;
      if (taken.has(c.side) || open.has(c.id) || !usable(c.side, c.entry, c.sl, c.tp, a.price, pip)) continue;
      const rising = day.c >= day.o;
      const day1 = fillDay(c.side, day, c.entry, c.sl, c.tp, rising);
      if (!day1) continue;
      taken.add(c.side);
      const tr: RawTrade = {
        symbol,
        side: c.side,
        entryAt: day.t,
        exitAt: null,
        entry: c.entry,
        tp: c.tp,
        sl: c.sl,
        result: 'Open',
        tpPips: roundTo(Math.abs(c.tp - c.entry) / pip, 2),
        slPips: roundTo(Math.abs(c.entry - c.sl) / pip, 2),
        pips: 0,
        r: 0,
        ambiguous: false,
        digits: data.digits,
      };
      if (day1.exit) {
        tr.result = day1.exit;
        tr.exitAt = day.t;
        tr.pips = roundTo(day1.exit === 'TP' ? tr.tpPips : -tr.slPips, 2);
        tr.r = roundTo(day1.exit === 'TP' ? tr.tpPips / tr.slPips : -1, 4);
        // the other traversal of the candle gives another result: the D1 data cannot say
        tr.ambiguous = fillDay(c.side, day, c.entry, c.sl, c.tp, !rising)?.exit !== day1.exit;
      } else {
        open.set(c.id, tr);
      }
      trades.push(tr);
    }
  }
  return trades;
}

// Applies the money: balance and risk per trade, compounding on closed trades.
export function compound(raw: RawTrade[], balance: number, riskPct: number): BtTrade[] {
  const sorted = [...raw].sort((a, b) => a.entryAt - b.entryAt || a.symbol.localeCompare(b.symbol) || a.entry - b.entry);
  const out: BtTrade[] = [];
  const pending: BtTrade[] = []; // sized, not yet counted in the balance
  let bal = balance;
  for (const r of sorted) {
    // trades that closed before this day count now; a trade closing the same day does not
    for (let k = pending.length - 1; k >= 0; k--) {
      const p = pending[k]!;
      if (p.exitAt !== null && p.exitAt < r.entryAt) {
        bal += p.profit;
        pending.splice(k, 1);
      }
    }
    const riskMoney = roundTo((Math.max(bal, 0) * riskPct) / 100, 2);
    const closed = r.result !== 'Open';
    const t: BtTrade = { ...r, riskMoney, profit: closed ? roundTo(riskMoney * r.r, 2) : 0, balanceBefore: roundTo(bal, 2) };
    out.push(t);
    if (closed) pending.push(t);
  }
  return out;
}

// The same run with some pairs left out. The balance is shared, so sizes and profits of the
// pairs that stay are redone; filtering the finished trades would keep the old sizing.
export function withoutPairs(trades: BtTrade[], excluded: ReadonlySet<string>, balance: number, riskPct: number): BtTrade[] {
  if (excluded.size === 0) return trades;
  return compound(toRaw(trades).filter((t) => !excluded.has(t.symbol)), balance, riskPct);
}

// --- trading costs ---------------------------------------------------------------
// The candles are bid prices and the replay fills and exits on them, so the trades are
// gross: no spread, commission or slippage. The cost is taken off each closed trade afterwards:
// spread + commission + slippage in pips, and that over the trade's SL distance in R. A buy stop fills
// on the ask and a sell closes on the ask, so every round trip pays the spread once.
// Applied after the replay, the costs (and a Gross/Net switch) change nothing that needs a
// new run, and saved results get them too.

// spreadPips: per pair, overrides the defaults; slippagePips: extra per trade, every pair;
// commissionPerLot: USD per lot for the round trip (open + close), 0 = none
export type CostSettings = { enabled: boolean; slippagePips: number; spreadPips: Record<string, number>; commissionPerLot: number };

export const DEFAULT_COSTS: CostSettings = { enabled: true, slippagePips: 0, spreadPips: {}, commissionPerLot: 10 };

// The "start from" spreads of a Maxrich Premium account, in pips (pipSize). These are the
// tightest the broker quotes, so real averages (news, rollover) run wider; the account
// pays USD 10 per lot commission on top (DEFAULT_COSTS.commissionPerLot).
export const DEFAULT_SPREAD_PIPS: Record<string, number> = {
  EURUSD: 0.5, USDCHF: 0.5,
  USDJPY: 0.8, GBPUSD: 0.8, AUDUSD: 0.8, NZDUSD: 0.8, USDCAD: 0.8,
  EURGBP: 1, AUDJPY: 1,
  AUDCAD: 1.5, AUDCHF: 1.5, CADJPY: 1.5, CHFJPY: 1.5, EURAUD: 1.5, EURCHF: 1.5, EURJPY: 1.5,
  GBPJPY: 2, EURCAD: 2, AUDNZD: 2, NZDJPY: 2,
  EURNZD: 2.5, GBPAUD: 2.5, GBPCAD: 2.5,
  GBPNZD: 4.5,
};
const GOLD_SPREAD = 0.3; // XAUUSD in price ($); its pip depends on the broker's digits
export const FALLBACK_SPREAD_PIPS = 2;

export function defaultSpreadPips(symbol: string, digits: number): number {
  const s = symbol.toUpperCase();
  if (s.startsWith('XAUUSD')) return roundTo(GOLD_SPREAD / pipSize(digits), 4);
  return DEFAULT_SPREAD_PIPS[s] ?? DEFAULT_SPREAD_PIPS[s.slice(0, 6)] ?? FALLBACK_SPREAD_PIPS;
}

export function spreadPipsOf(symbol: string, digits: number, costs: CostSettings): number {
  return costs.spreadPips[symbol] ?? defaultSpreadPips(symbol, digits);
}

// Rough USD value of one unit of the quote currency (a pip's money depends on it). Fixed
// round rates are enough: the commission is a small part of the cost.
const QUOTE_TO_USD: Record<string, number> = { USD: 1, JPY: 1 / 150, CAD: 0.72, CHF: 1.25, GBP: 1.3, AUD: 0.65, NZD: 0.6, EUR: 1.1 };

// USD one pip is worth on one lot: 100,000 units of a forex pair, 100 oz of gold.
export function pipValuePerLot(symbol: string, digits: number): number {
  const s = symbol.toUpperCase();
  if (s.startsWith('XAUUSD')) return 100 * pipSize(digits);
  return 100_000 * pipSize(digits) * (QUOTE_TO_USD[s.slice(3, 6)] ?? 1);
}

// The commission of a round trip, in pips of the pair.
export function commissionPipsOf(symbol: string, digits: number, costs: CostSettings): number {
  return costs.commissionPerLot > 0 ? costs.commissionPerLot / pipValuePerLot(symbol, digits) : 0;
}

// The cost of one trade in pips (spread + commission + slippage); 0 when costs are off.
export function costPipsOf(symbol: string, digits: number, costs: CostSettings): number {
  return costs.enabled ? spreadPipsOf(symbol, digits, costs) + commissionPipsOf(symbol, digits, costs) + costs.slippagePips : 0;
}

// The trades net of costs. A TP whose cost is larger than its distance becomes a loss in
// pips and R but stays a TP.
export function withCosts(raw: RawTrade[], costs: CostSettings): RawTrade[] {
  if (!costs.enabled) return raw;
  return raw.map((t) => {
    if (t.result === 'Open') return t;
    const cost = costPipsOf(t.symbol, t.digits, costs);
    return { ...t, pips: roundTo(t.pips - cost, 2), r: roundTo(t.r - cost / t.slPips, 4) };
  });
}

// Drops the money again, so another balance or risk % can be applied without a replay.
export function toRaw(trades: BtTrade[]): RawTrade[] {
  return trades.map(({ riskMoney: _risk, profit: _profit, balanceBefore: _before, ...t }) => t);
}

export type Coverage = {
  symbol: string;
  candles: number;
  from: number | null; // first candle
  testFrom: number | null; // first day an order was possible
  to: number | null;
  years: number; // tested span
  tier: 'none' | 'short' | 'min' | 'good' | 'better' | 'perfect';
  gaps: { from: number; to: number; days: number }[]; // holes in the tested span (first 20)
  gapDays: number; // total days missing inside the tested span
};

// 2 years is the least that says anything; 5 / 10 / 20 are the steps above it.
export function tierOf(years: number): Coverage['tier'] {
  if (years >= 20) return 'perfect';
  if (years >= 10) return 'better';
  if (years >= 5) return 'good';
  if (years >= 2) return 'min';
  return years > 0 ? 'short' : 'none';
}

// Holes longer than this many days between two candles are missing history, not a weekend
// or a holiday (the longest normal break, Christmas to New Year, is about 5 days).
export const GAP_DAYS = 7;

export function coverageOf(symbol: string, cs: Candle[], opts: ReplayOptions): Coverage {
  const startIdx = Math.max(opts.warmup, 10);
  const days = cs.filter((c, i) => i >= startIdx && (opts.from === undefined || c.t >= opts.from) && (opts.to === undefined || c.t <= opts.to));
  const DAY_MS = 86_400_000;
  // holes inside the tested span; the history before it only feeds the first analyses
  const gaps: Coverage['gaps'] = [];
  for (let i = 1; i < days.length; i++) {
    const d = (days[i]!.t - days[i - 1]!.t) / DAY_MS;
    if (d > GAP_DAYS) gaps.push({ from: days[i - 1]!.t, to: days[i]!.t, days: Math.round(d) });
  }
  const gapDays = gaps.reduce((s, g) => s + g.days, 0);
  const span = days.length ? (days[days.length - 1]!.t - days[0]!.t) / DAY_MS : 0;
  // years that really have candles: the span minus its holes
  const years = Math.max(span - gapDays, 0) / 365.25;
  return {
    symbol,
    candles: cs.length,
    from: cs[0]?.t ?? null,
    testFrom: days[0]?.t ?? null,
    to: cs[cs.length - 1]?.t ?? null,
    years: roundTo(years, 2),
    tier: tierOf(years),
    gaps: gaps.slice(0, 20),
    gapDays,
  };
}

export type BacktestInput = {
  data: Map<string, SymbolData>;
  params: SrParams;
  balance: number;
  riskPct: number;
  warmup?: number;
  from?: number;
  to?: number;
  onProgress?: (done: number, total: number) => void;
  pause?: () => Promise<void>; // default: give the event loop a turn every ~10 ms; a worker passes a no-op
};

export type BacktestRun = { trades: BtTrade[]; coverage: Coverage[]; warmup: number };

// Symbols run one after another; the event loop gets a turn every few milliseconds.
// Trades still open on the last candle are left out: they have no result yet. While the
// replay runs they still count, so their level is not placed again.
export async function runBacktest(input: BacktestInput): Promise<BacktestRun> {
  const warmup = input.warmup ?? Math.min(input.params.lookback, 260);
  const opts: ReplayOptions = { warmup, ...(input.from !== undefined ? { from: input.from } : {}), ...(input.to !== undefined ? { to: input.to } : {}) };
  const names = [...input.data.keys()].sort();
  const raw: RawTrade[] = [];
  const coverage: Coverage[] = [];
  let done = 0;
  const pause = input.pause ?? makePause();
  for (const name of names) {
    const d = input.data.get(name)!;
    coverage.push(coverageOf(name, d.candles, opts));
    for (const t of await replaySymbol(name, d, input.params, opts, pause)) if (t.result !== 'Open') raw.push(t);
    input.onProgress?.(++done, names.length);
    await pause();
  }
  return { trades: compound(raw, input.balance, input.riskPct), coverage, warmup };
}
