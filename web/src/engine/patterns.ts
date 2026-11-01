// Double top / double bottom, traded to the locked S/R lines. Backtest only: nothing here
// reaches the live orders, the EA or the settings.
//
// Top 1 is a swing high: higher than the swingBars candles on each side, so it is known
// only once the last of them has closed. Once price has pulled back from it by at least
// minDropAtr x ATR, the first candle that comes back up into its zone (sameTopAtr x ATR
// under the high, or above it) is top 2: the double top. It needs no rejection of its own
// and there is no time limit between the tops; a higher high before the pullback means
// there was no top 1. What follows decides it: a reversal candle and a fall to the target
// (success), or no reversal and a break past top 1 (fail), also when top 2 itself breaks
// straight through. Top 2 is the next top 1 unless it broke the level (a triple top gives
// two patterns). Bottoms are the mirror, found by running the same rules on the price
// mirror. No neckline, no trend filter. This follows the boxes JohnPaul77 marks by hand.
//
// The targets are the engine's S/R lines of that morning, drawn from the candles that had
// closed, exactly as replaySymbol sees them, so the walk never looks ahead. Every distance
// is in ATR or in the gap between two lines, never in pips, so pairs and decades compare.
//
// The reversal target is the next line beyond the pattern, less tpGap x g (the TP the
// ladder uses); the break level is top 1 + breakoutBufferAtr x ATR. Whichever is traded
// first decides; a candle that does both, or nothing within resolveBars, leaves it grey.
// The four strategies trade the two branches of tops and of bottoms; each is meant for
// its own account.
import { analyze, roundTo, strongBehind } from './sr.ts';
import type { Candidate, Candle, Line, Side, SrParams } from './types.ts';

export type PatternKind = 'top' | 'bottom';
export type PatternStatus = 'success' | 'fail' | 'grey'; // success = reversal branch, fail = breakout
export type PatternStrategy = 'top-sell' | 'top-buy' | 'bottom-buy' | 'bottom-sell';
export const PATTERN_STRATEGIES: PatternStrategy[] = ['top-sell', 'top-buy', 'bottom-buy', 'bottom-sell'];

export type PatternParams = {
  swingBars: number; // top 1: higher than this many candles on each side
  sameTopAtr: number; // top 2 comes within this x ATR of top 1 (its zone)
  minDropAtr: number; // pullback from top 1 before top 2 counts
  breakoutBufferAtr: number; // break level = top 1 + this x ATR (breakOn 'wick')
  // when the pattern has failed: 'close' = a candle closes above top 1 (a wick through it
  // that closes back below is still a top, as in JohnPaul77's examples); 'wick' = price
  // trades at the break level
  breakOn: 'close' | 'wick';
  slBufferAtr: number; // reversal SL beyond the tops, breakout SL beyond the zone
  minRr: number; // orders with a smaller TP / SL distance are not placed
  // 'rr' = TP at tpRr x the risk from the entry (JohnPaul77: SL 150, TP 300 pips on gold);
  // 'line' = the next S/R line less tpGap x g, as in the ladder
  tpMode: 'rr' | 'line';
  tpRr: number;
  tpGap: number;
  // the TP line must lie at least this x ATR beyond top 1 (and beyond its zone); 0 = the
  // next line past the zone
  minTargetAtr: number;
  maxBetweenBars: number; // a top 1 older than this many candles is forgotten; 0 = never
  resolveBars: number; // a pattern undecided after this many candles is grey
  // reversal entry: 'close' = at the confirmation candle's close (a stop there, so about
  // the next open), 'extreme' = stop at its low (high for bottoms)
  entryMode: 'extreme' | 'close';
  orderDays: number; // days an order stays up after it is placed, unless invalidated
  // 'candle' = SL behind the nearest strong candle, the rule of Breakout JohnPaul77's
  // candle SL (strongBehind with the strong* / bufferAtr / slMaxRiskAtr settings), falling
  // back to the pattern SL when there is none or it is too wide; 'pattern' = always the
  // pattern SL (beyond the tops for the reversal, under the zone for the breakout);
  // 'fixed' = slAtr x ATR from the entry (JohnPaul77's 150 pips on gold, 2023-24, in ATR)
  slMode: 'fixed' | 'candle' | 'pattern';
  slAtr: number;
};

export const DEFAULT_PATTERN: PatternParams = {
  swingBars: 3,
  sameTopAtr: 0.5,
  minDropAtr: 1.5, // JohnPaul77's 8 -> 20 Mar 2024 XAUUSD example pulled back 2.0 ATR
  breakoutBufferAtr: 0.1,
  breakOn: 'close',
  slBufferAtr: 0.1,
  minRr: 2,
  tpMode: 'rr',
  tpRr: 2,
  tpGap: 0.07,
  minTargetAtr: 0,
  maxBetweenBars: 0,
  resolveBars: 60,
  entryMode: 'close',
  orderDays: 1,
  slMode: 'fixed',
  slAtr: 0.6,
};

// Settings locked per strategy after the in-sample / out-of-sample check (Nov 2026): chosen
// on 2004-15 only, from the middle of a stable area (pullback 1.5-2 ATR, SL 1-1.5 ATR, TP
// 2-3R all held up), then tested once on 2016-26. top-buy: +0.12R in-sample, +0.09R
// out-of-sample net, against +0.00 / +0.05R for a buy on every day with the same SL/TP.
// Strategies without an entry run on DEFAULT_PATTERN.
export const PATTERN_LOCKED: Partial<Record<PatternStrategy, Partial<PatternParams>>> = {
  'top-buy': { minDropAtr: 1.5, breakOn: 'close', slMode: 'fixed', slAtr: 1.5, tpMode: 'rr', tpRr: 2, orderDays: 1 },
};

// The settings a strategy runs on: its locked ones, then any override of a test.
export const patternParamsFor = (strategy: PatternStrategy, overrides: Partial<PatternParams> = {}): PatternParams => ({
  ...DEFAULT_PATTERN,
  ...PATTERN_LOCKED[strategy],
  ...overrides,
});

// The lines and ATR the engine had on the morning of a candle; null where not computed.
export type DayLines = { lines: Line[]; atr: number } | null;

export type Touch = { i: number; t: number; extreme: number }; // extreme: high of a top, low of a bottom

export type PatternEvent = {
  kind: PatternKind;
  line: number; // the pattern level: top 1's high (low of a bottom)
  atr: number; // ATR when top 1 became known; every distance of the pattern uses it
  first: Touch;
  second: Touch;
  extreme: number; // highest high of the two tops (lowest low of the bottoms)
  breakLevel: number; // top 1 + breakoutBufferAtr x ATR
  target: number | null; // reversal TP; null when no line lies beyond the pattern
  status: PatternStatus;
  resolvedAt: number | null; // the candle that decided it
  greyBy?: 'both' | 'timeout' | 'no-target' | 'end';
};

// Price mirror: tops of the mirror are bottoms of the real chart.
const flipCandle = (c: Candle): Candle => ({ t: c.t, o: -c.o, h: -c.l, l: -c.h, c: -c.c });
const flipDay = (d: DayLines): DayLines => (d ? { atr: d.atr, lines: d.lines.map((l) => ({ ...l, price: -l.price, low: -l.high, high: -l.low })) } : null);

// The engine's lines on the morning of every candle in [from, to] (indexes); slow part.
export async function linesByDay(cs: Candle[], p: SrParams, digits: number, from: number, to = cs.length - 1, pause?: () => Promise<void>): Promise<DayLines[]> {
  const out: DayLines[] = new Array(cs.length).fill(null);
  for (let i = Math.max(from, 1); i <= to && i < cs.length; i++) {
    const a = analyze('', cs.slice(Math.max(0, i - p.lookback), i), p, digits);
    out[i] = a.atr > 0 ? { lines: a.lines, atr: a.atr } : null;
    if (pause) await pause();
  }
  return out;
}

// Reversal TP below a top at `level`: the next line under its zone (and at least
// minTargetAtr away), plus tpGap x g.
function targetBelow(level: number, d: DayLines, atrValue: number, pp: PatternParams): number | null {
  if (!d) return null;
  const gap = Math.max(pp.sameTopAtr, pp.minTargetAtr) * atrValue;
  const next = d.lines.filter((l) => l.price < level - gap).reduce<number | null>((m, l) => (m === null || l.price > m ? l.price : m), null);
  return next === null ? null : next + pp.tpGap * (level - next);
}

// The candle that makes a top fail: closes above top 1, or trades at the break level.
const breaks = (c: Candle, level: number, breakLevel: number, pp: PatternParams): boolean => (pp.breakOn === 'close' ? c.c > level : c.h >= breakLevel);

function isSwingHigh(cs: Candle[], k: number, n: number): boolean {
  for (let m = 1; m <= n; m++) if (!(cs[k]!.h > cs[k - m]!.h && cs[k]!.h > cs[k + m]!.h)) return false;
  return true;
}

// Double tops of an (oriented) series; bottoms come from the mirror.
function findTops(cs: Candle[], days: DayLines[], pp: PatternParams, kind: PatternKind): PatternEvent[] {
  // armed: the pullback is done, so the next candle in the zone is top 2
  type Top = { touch: Touch; atr: number; low: number; armed: boolean };
  let tops: Top[] = [];
  const seen = new Set<number>(); // candles that have been a top 1 once
  const out: PatternEvent[] = [];
  const n = pp.swingBars;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    const d = days[i];
    // this candle against the tops known this morning
    const next: Top[] = [];
    for (const q of tops) {
      if (q.armed && c.h >= q.touch.extreme - pp.sameTopAtr * q.atr) {
        const e = resolve(cs, days, pp, kind, q, { i, t: c.t, extreme: c.h });
        out.push(e);
        // top 2 is the next top 1, unless it broke the level
        if (!breaks(c, e.line, e.breakLevel, pp) && !seen.has(i)) {
          seen.add(i);
          next.push({ touch: e.second, atr: d?.atr ?? q.atr, low: Infinity, armed: false });
        }
        continue;
      }
      if (!q.armed && c.h > q.touch.extreme) continue; // higher before any pullback: no top
      if (pp.maxBetweenBars > 0 && i - q.touch.i > pp.maxBetweenBars) continue;
      next.push(q);
    }
    tops = next;
    // the pullback, counted at the close
    for (const q of tops) {
      if (q.touch.i === i) continue;
      q.low = Math.min(q.low, c.l);
      if (!q.armed && q.touch.extreme - q.low >= pp.minDropAtr * q.atr) q.armed = true;
    }
    // a swing high whose right side closes with this candle; known from tomorrow
    const k = i - n;
    const atrValue = days[i + 1]?.atr ?? d?.atr;
    if (k >= n && atrValue && isSwingHigh(cs, k, n) && !seen.has(k)) {
      seen.add(k);
      const low = Math.min(...cs.slice(k + 1, i + 1).map((x) => x.l));
      tops.push({ touch: { i: k, t: cs[k]!.t, extreme: cs[k]!.h }, atr: atrValue, low, armed: cs[k]!.h - low >= pp.minDropAtr * atrValue });
    }
  }
  return out;
}

function resolve(cs: Candle[], days: DayLines[], pp: PatternParams, kind: PatternKind, top: { touch: Touch; atr: number }, second: Touch): PatternEvent {
  const first = top.touch;
  const level = first.extreme;
  const breakLevel = level + pp.breakoutBufferAtr * top.atr;
  const extreme = Math.max(level, Math.min(second.extreme, breakLevel));
  // the lines once top 2 has closed
  const target = targetBelow(level, days[second.i + 1] ?? days[second.i] ?? null, top.atr, pp);
  const e: PatternEvent = { kind, line: level, atr: top.atr, first, second, extreme, breakLevel, target, status: 'grey', resolvedAt: null };
  const last = Math.min(second.i + pp.resolveBars, cs.length - 1);
  // top 2 itself can break straight through; its low came before it rose, so it never
  // reaches the target
  for (let k = second.i; k <= last; k++) {
    const c = cs[k]!;
    const up = breaks(c, level, breakLevel, pp);
    const down = k > second.i && target !== null && c.l <= target;
    if (!up && !down) continue;
    e.resolvedAt = c.t;
    if (up && down) e.greyBy = 'both';
    else e.status = up ? 'fail' : 'success';
    return e;
  }
  e.greyBy = target === null ? 'no-target' : second.i + pp.resolveBars > cs.length - 1 ? 'end' : 'timeout';
  return e;
}

const unflip = (e: PatternEvent): PatternEvent => ({
  ...e,
  line: -e.line,
  extreme: -e.extreme,
  breakLevel: -e.breakLevel,
  target: e.target === null ? null : -e.target,
  first: { ...e.first, extreme: -e.first.extreme },
  second: { ...e.second, extreme: -e.second.extreme },
});

// All double tops and bottoms, in order of their second touch.
export function detectPatterns(cs: Candle[], days: DayLines[], pp: PatternParams = DEFAULT_PATTERN): PatternEvent[] {
  const tops = findTops(cs, days, pp, 'top');
  const bottoms = findTops(cs.map(flipCandle), days.map(flipDay), pp, 'bottom').map(unflip);
  return [...tops, ...bottoms].sort((a, b) => a.second.i - b.second.i || (a.kind === 'top' ? -1 : 1));
}

// --- orders ----------------------------------------------------------------------
// Each pattern gives two stop orders, one per branch, worked out on the oriented series
// (a top; bottoms through the mirror):
//   reversal: from top 2 on, the first bearish candle (close < open; top 2 itself counts)
//     is the reversal candle; sell stop at its low (or close) from the next day, TP at the
//     next line below less tpGap x g.
//   breakout: buy stop at the break level, TP at the next line above less tpGap x g. It
//     stands once the pullback from top 1 is done, so it is there on the morning of top 2
//     (a top 2 that breaks straight through fills it); only that morning and the
//     orderDays after it can fill, so those are the days it is placed.
// The SL sits behind the nearest strong candle on the SL side of the entry, as the candle
// SL of Breakout JohnPaul77 does at its line (slMode 'candle'); without one, or when that
// risks more than slMaxRiskAtr x ATR, it is the pattern SL: above the extreme +
// slBufferAtr for the reversal, under the zone of top 1 - slBufferAtr for the breakout.
// Each order is placed only with TP / SL >= minRr and stays up orderDays days. When price
// reaches one branch's entry the pattern has resolved and the other branch is withdrawn,
// whatever the account of that branch could take, so the four stay independent. Before
// that, a branch ends once the pattern has gone the other way: the reversal when price
// trades at the break level (or its SL), the breakout when price reaches the reversal
// target.

type Plan = { side: Side; entry: number; sl: number; tp: number; from: number; to: number; slFrom: 'candle' | 'ladder' };

export type PatternOrders = Record<PatternStrategy, Map<number, Candidate[]>>;

function planOrders(cs: Candle[], days: DayLines[], e: PatternEvent, p: SrParams, pp: PatternParams, emit: (branch: 'rev' | 'brk', day: number, o: Plan) => void): void {
  const j = e.second.i;
  const A = e.atr;
  const level = e.line;
  const zone = pp.sameTopAtr * A;
  // (a hair of slack: a TP of exactly minRr x the risk must not fail on float rounding)
  const okRr = (entry: number, sl: number, tp: number) => Math.abs(tp - entry) >= pp.minRr * Math.abs(entry - sl) * (1 - 1e-9) && Math.abs(entry - sl) > 0;
  // the SL of an order placed on the morning of candle `day`, from the candles closed by then
  const slOf = (side: Side, entry: number, day: number, fallback: number): { sl: number; slFrom: 'candle' | 'ladder' } => {
    if (pp.slMode === 'fixed') return { sl: side === 'buy' ? entry - pp.slAtr * A : entry + pp.slAtr * A, slFrom: 'ladder' };
    if (pp.slMode === 'candle') {
      const a = days[day]?.atr ?? A;
      const win = cs.slice(Math.max(0, day - p.lookback), day);
      const k = strongBehind(win, entry, side, a, p);
      if (k !== undefined) {
        const sl = side === 'buy' ? win[k]!.l - p.bufferAtr * a : win[k]!.h + p.bufferAtr * a;
        if (Math.abs(entry - sl) <= p.slMaxRiskAtr * a) return { sl, slFrom: 'candle' };
      }
    }
    return { sl: fallback, slFrom: 'ladder' };
  };
  const tpOf = (side: Side, entry: number, sl: number, day: number): number | null => {
    if (pp.tpMode === 'rr') return entry + (side === 'buy' ? 1 : -1) * pp.tpRr * Math.abs(entry - sl);
    if (side === 'sell') return targetBelow(level, days[day] ?? null, A, pp);
    const next = days[day]?.lines.filter((l) => l.price > Math.max(entry, level + pp.minTargetAtr * A)).reduce<number | null>((m, l) => (m === null || l.price < m ? l.price : m), null);
    return next === undefined || next === null ? null : next - pp.tpGap * (next - level);
  };
  // an order from the morning of `day`, if its geometry and RR hold
  const make = (side: Side, entry: number, day: number, fallbackSl: number): Plan | null => {
    const { sl, slFrom } = slOf(side, entry, day, fallbackSl);
    const tp = tpOf(side, entry, sl, day);
    if (tp === null || !(side === 'buy' ? tp > entry : tp < entry) || !okRr(entry, sl, tp)) return null;
    return { side, entry, sl, tp, from: day, to: day + pp.orderDays - 1, slFrom };
  };
  const breakoutSl = level - zone - pp.slBufferAtr * A;

  // breakOn 'wick': the breakout stop stands at the break level; 'close': it is placed at
  // the close of the candle that closes above top 1
  let brk: Plan | null = null;
  let brkWaiting = pp.breakOn === 'close';
  if (!brkWaiting && days[j]) {
    brk = make('buy', e.breakLevel, j, breakoutSl);
    if (brk) brk.to = j + pp.orderDays;
  }
  let rev: Plan | null = null;
  let revWaiting = true; // still waiting for the confirmation candle
  const last = Math.min(j + pp.resolveBars, cs.length - 1);
  for (let d = j; d <= last; d++) {
    const revLive = rev && d >= rev.from && d <= rev.to;
    const brkLive = brk && d >= brk.from && d <= brk.to;
    if (!revLive && !brkLive && !revWaiting && !brkWaiting && !(rev && d < rev.from) && !(brk && d < brk.from)) return;
    if (revLive) emit('rev', d, rev!);
    if (brkLive) emit('brk', d, brk!);
    const c = cs[d]!;
    // reaching either entry resolves the pattern
    if ((revLive && c.l <= rev!.entry) || (brkLive && c.h >= brk!.entry)) return;
    if (rev && c.h >= rev.sl) rev = null;
    const up = breaks(c, level, e.breakLevel, pp);
    if (up) {
      rev = null;
      revWaiting = false;
    }
    if (d > j && e.target !== null && c.l <= e.target) {
      if (pp.breakOn === 'wick') brk = null;
      brkWaiting = false;
      revWaiting = false;
    }
    if (brkWaiting && up) {
      brkWaiting = false;
      brk = make('buy', c.c, d + 1, breakoutSl);
    }
    if (revWaiting && c.c < c.o) {
      // the first bearish candle is the confirmation; one chance only
      revWaiting = false;
      rev = make('sell', pp.entryMode === 'close' ? c.c : c.l, d + 1, e.extreme + pp.slBufferAtr * A);
    }
  }
}

// Every day's orders of the four strategies. Only days in [from, to] (indexes) are kept.
export function patternOrders(symbol: string, cs: Candle[], days: DayLines[], events: PatternEvent[], p: SrParams, pp: PatternParams, digits: number): PatternOrders {
  const out: PatternOrders = { 'top-sell': new Map(), 'top-buy': new Map(), 'bottom-buy': new Map(), 'bottom-sell': new Map() };
  const flipped = { cs: cs.map(flipCandle), days: days.map(flipDay) };
  for (const ev of events) {
    const top = ev.kind === 'top';
    const e = top ? ev : unflip(ev); // oriented: bottoms as tops of the mirror
    const sgn = top ? 1 : -1;
    planOrders(top ? cs : flipped.cs, top ? days : flipped.days, e, p, pp, (branch, day, o) => {
      const strategy: PatternStrategy = top ? (branch === 'rev' ? 'top-sell' : 'top-buy') : branch === 'rev' ? 'bottom-buy' : 'bottom-sell';
      const side: Side = top ? o.side : o.side === 'buy' ? 'sell' : 'buy';
      const cand: Candidate = {
        id: `${symbol}:${strategy}-${ev.second.t}`,
        side,
        line: roundTo(ev.line, digits),
        entry: roundTo(sgn * o.entry, digits),
        sl: roundTo(sgn * o.sl, digits),
        tp: roundTo(sgn * o.tp, digits),
        slFrom: o.slFrom,
      };
      const list = out[strategy].get(day);
      if (list) list.push(cand);
      else out[strategy].set(day, [cand]);
    });
  }
  return out;
}

// --- statistics -------------------------------------------------------------------

export type PatternCount = { patterns: number; success: number; fail: number; grey: number };
export type PatternStats = { top: PatternCount; bottom: PatternCount; byYear: Map<number, { top: PatternCount; bottom: PatternCount }> };

const emptyCount = (): PatternCount => ({ patterns: 0, success: 0, fail: 0, grey: 0 });

export function patternStats(events: PatternEvent[]): PatternStats {
  const s: PatternStats = { top: emptyCount(), bottom: emptyCount(), byYear: new Map() };
  for (const e of events) {
    const y = new Date(e.second.t).getUTCFullYear();
    const row = s.byYear.get(y) ?? { top: emptyCount(), bottom: emptyCount() };
    s.byYear.set(y, row);
    for (const c of [s[e.kind], row[e.kind]]) {
      c.patterns++;
      c[e.status]++;
    }
  }
  return s;
}
