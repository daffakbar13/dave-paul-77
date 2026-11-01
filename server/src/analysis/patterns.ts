// Double top / double bottom on the locked S/R lines. Backtest only: nothing here reaches
// the live orders, the EA or the settings.
//
// A top is a D1 candle that comes up into a resistance line's zone (clusterAtr x ATR on
// either side of the line) from below and closes back under the line. A double top is a
// second top at the same line (within the same zone) after price first dropped away from
// the line by at least minDropAtr x ATR; without that drop it is one long push and the
// later candle replaces the first. After a double top the second top is the first top of
// the next one (a triple top gives two patterns). Bottoms are the mirror at support, and
// are found by running the top rules on the price mirror. No neckline, no trend filter.
//
// The lines of a day are the ones the engine drew that morning from the candles that had
// closed, exactly as replaySymbol sees them, so the walk never looks ahead. Every distance
// is in ATR or in the gap between two lines, never in pips, so pairs and decades compare.
//
// A pattern resolves one of two ways: the reversal (price reaches the next line beyond,
// less tpGap x g, the same TP the ladder uses) or the breakout (price trades past the
// tops' extreme by breakoutBufferAtr x ATR). Whichever comes first decides; a candle that
// does both, or nothing within resolveBars, leaves it grey. The four strategies trade
// the two branches of tops and of bottoms; each is meant for its own account.
import { analyze, roundTo, SR_LINES } from './sr.ts';
import type { Candidate, Candle, Line, Side, SrParams } from './types.ts';

export type PatternKind = 'top' | 'bottom';
export type PatternStatus = 'success' | 'fail' | 'grey'; // success = reversal branch, fail = breakout
export type PatternStrategy = 'top-sell' | 'top-buy' | 'bottom-buy' | 'bottom-sell';
export const PATTERN_STRATEGIES: PatternStrategy[] = ['top-sell', 'top-buy', 'bottom-buy', 'bottom-sell'];

export type PatternParams = {
  minDropAtr: number; // drop away from the line between the two tops
  breakoutBufferAtr: number; // breakout level = tops' extreme + this x ATR
  slBufferAtr: number; // reversal SL beyond the extreme, breakout SL beyond the line zone
  minRr: number; // orders with a smaller TP / SL distance are not placed
  tpGap: number; // TP = next line - tpGap x g, as in the ladder
  // the TP line must lie at least this x ATR beyond the pattern line; 0 = simply the next
  // line. The locked lines sit ~0.75 ATR apart, so the next line is often within a candle.
  minTargetAtr: number;
  maxBetweenBars: number; // a first top older than this many candles is forgotten
  resolveBars: number; // a pattern undecided after this many candles is grey
  // reversal entry: 'extreme' = stop at the confirmation candle's low (high for bottoms),
  // 'close' = stop at its close, i.e. about the next open
  entryMode: 'extreme' | 'close';
  orderDays: number; // days an order stays up (1 = only the next day), unless invalidated
};

export const DEFAULT_PATTERN: PatternParams = {
  minDropAtr: 1,
  breakoutBufferAtr: 0.1,
  slBufferAtr: 0.1,
  minRr: 2,
  tpGap: 0.07,
  minTargetAtr: 0,
  maxBetweenBars: 120,
  resolveBars: 60,
  entryMode: 'extreme',
  orderDays: 1,
};

// The lines and ATR the engine had on the morning of a candle; null where not computed.
export type DayLines = { lines: Line[]; atr: number } | null;

export type Touch = { i: number; t: number; extreme: number }; // extreme: high of a top, low of a bottom

export type PatternEvent = {
  kind: PatternKind;
  line: number; // the line at the second touch
  atr: number; // ATR on the morning of the second touch
  first: Touch;
  second: Touch;
  extreme: number; // highest high of the tops (lowest low of the bottoms)
  breakLevel: number; // extreme + breakoutBufferAtr x ATR
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

// The line a candle tops at: it opens and closes below the line, its high lies in the
// line's zone. Of two lines the one nearest the high.
function topLine(c: Candle, d: NonNullable<DayLines>): number | null {
  const zone = SR_LINES.clusterAtr * d.atr;
  let best: number | null = null;
  for (const l of d.lines) {
    if (!(c.o < l.price && c.c < l.price && c.h >= l.price - zone && c.h <= l.price + zone)) continue;
    if (best === null || Math.abs(c.h - l.price) < Math.abs(c.h - best)) best = l.price;
  }
  return best;
}

// Reversal TP below a resistance at `line`: the next line under its zone (and at least
// minTargetAtr away), plus tpGap x g.
function targetBelow(line: number, d: DayLines, pp: PatternParams): number | null {
  if (!d) return null;
  const gap = Math.max(SR_LINES.clusterAtr, pp.minTargetAtr) * d.atr;
  const next = d.lines.filter((l) => l.price < line - gap).reduce<number | null>((m, l) => (m === null || l.price > m ? l.price : m), null);
  return next === null ? null : next + pp.tpGap * (line - next);
}

// Double tops of an (oriented) series; bottoms come from the mirror.
function findTops(cs: Candle[], days: DayLines[], pp: PatternParams, kind: PatternKind): PatternEvent[] {
  type Pending = { anchor: number; touch: Touch; low: number };
  let pending: Pending[] = [];
  const out: PatternEvent[] = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    const d = days[i];
    if (!d) continue;
    const zone = SR_LINES.clusterAtr * d.atr;
    const line = topLine(c, d);
    let touched: Pending | null = null;
    if (line !== null) {
      const touch: Touch = { i, t: c.t, extreme: c.h };
      const k = pending.findIndex((q) => Math.abs(q.anchor - line) <= zone);
      const q = pending[k];
      if (q && line - q.low >= pp.minDropAtr * d.atr) {
        out.push(resolve(cs, days, pp, kind, q.touch, touch, line, d.atr));
        touched = { anchor: line, touch, low: Infinity };
        pending[k] = touched;
      } else if (q) {
        // no drop in between: the same push, carried on by this candle
        touched = { anchor: line, touch: { ...touch, extreme: Math.max(q.touch.extreme, c.h) }, low: Infinity };
        pending[k] = touched;
      } else {
        touched = { anchor: line, touch, low: Infinity };
        pending.push(touched);
      }
    }
    // a close above the zone breaks the line; an old first top is forgotten
    pending = pending.filter((q) => q === touched || (c.c <= q.anchor + zone && i - q.touch.i <= pp.maxBetweenBars));
    for (const q of pending) if (q !== touched) q.low = Math.min(q.low, c.l);
  }
  return out;
}

function resolve(cs: Candle[], days: DayLines[], pp: PatternParams, kind: PatternKind, first: Touch, second: Touch, line: number, atrValue: number): PatternEvent {
  const extreme = Math.max(first.extreme, second.extreme);
  const breakLevel = extreme + pp.breakoutBufferAtr * atrValue;
  // the lines once the second top has closed
  const target = targetBelow(line, days[second.i + 1] ?? days[second.i] ?? null, pp);
  const e: PatternEvent = { kind, line, atr: atrValue, first, second, extreme, breakLevel, target, status: 'grey', resolvedAt: null };
  const last = Math.min(second.i + pp.resolveBars, cs.length - 1);
  for (let k = second.i + 1; k <= last; k++) {
    const c = cs[k]!;
    const up = c.h >= breakLevel;
    const down = target !== null && c.l <= target;
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
//   reversal: after the second top, the first bearish candle (close < open) is the
//     confirmation; sell stop at its low (or close), SL above the extreme + slBufferAtr,
//     TP at the next line below less tpGap x g.
//   breakout: from the day after the second top, buy stop at the break level, SL under
//     the line zone - slBufferAtr, TP at the next line above less tpGap x g.
// Each order is placed only with TP / SL >= minRr and stays up orderDays days. When price
// reaches one branch's entry the pattern has resolved and the other branch is withdrawn,
// whatever the account of that branch could take, so the four stay independent. Before
// that, a branch ends once the pattern has gone the other way: the reversal when price
// trades at the break level (or its SL), the breakout when price reaches the reversal
// target.

type Plan = { side: Side; entry: number; sl: number; tp: number; from: number; to: number };

export type PatternOrders = Record<PatternStrategy, Map<number, Candidate[]>>;

function planOrders(cs: Candle[], days: DayLines[], e: PatternEvent, pp: PatternParams, emit: (branch: 'rev' | 'brk', day: number, o: Plan) => void): void {
  const j = e.second.i;
  const A = e.atr;
  const zone = SR_LINES.clusterAtr * A;
  const okRr = (entry: number, sl: number, tp: number) => Math.abs(tp - entry) >= pp.minRr * Math.abs(entry - sl) && Math.abs(entry - sl) > 0;

  let brk: Plan | null = null;
  const dB = days[j + 1];
  if (dB) {
    const entry = e.breakLevel;
    const sl = e.line - zone - pp.slBufferAtr * A;
    const next = dB.lines.filter((l) => l.price > Math.max(entry, e.line + pp.minTargetAtr * A)).reduce<number | null>((m, l) => (m === null || l.price < m ? l.price : m), null);
    const tp = next === null ? null : next - pp.tpGap * (next - e.line);
    if (tp !== null && tp > entry && okRr(entry, sl, tp)) brk = { side: 'buy', entry, sl, tp, from: j + 1, to: j + pp.orderDays };
  }

  let rev: Plan | null = null;
  let searching = true; // still waiting for the confirmation candle
  const last = Math.min(j + pp.resolveBars, cs.length - 1);
  for (let d = j + 1; d <= last; d++) {
    const revLive = rev && d >= rev.from && d <= rev.to;
    const brkLive = brk && d <= brk.to;
    if (!revLive && !brkLive && !searching) return;
    if (revLive) emit('rev', d, rev!);
    if (brkLive) emit('brk', d, brk!);
    const c = cs[d]!;
    // reaching either entry resolves the pattern
    if ((revLive && c.l <= rev!.entry) || (brkLive && c.h >= brk!.entry)) return;
    if (c.h >= e.breakLevel) {
      rev = null;
      searching = false;
    }
    if (rev && c.h >= rev.sl) rev = null;
    if (e.target !== null && c.l <= e.target) {
      brk = null;
      searching = false;
    }
    if (searching && c.c < c.o) {
      // the first bearish candle confirms; one chance only
      searching = false;
      const entry = pp.entryMode === 'close' ? c.c : c.l;
      const sl = e.extreme + pp.slBufferAtr * A;
      const tp = targetBelow(e.line, days[d + 1] ?? null, pp);
      if (tp !== null && tp < entry && okRr(entry, sl, tp)) rev = { side: 'sell', entry, sl, tp, from: d + 1, to: d + pp.orderDays };
    }
  }
}

// Every day's orders of the four strategies. Only days in [from, to] (indexes) are kept.
export function patternOrders(symbol: string, cs: Candle[], days: DayLines[], events: PatternEvent[], pp: PatternParams, digits: number): PatternOrders {
  const out: PatternOrders = { 'top-sell': new Map(), 'top-buy': new Map(), 'bottom-buy': new Map(), 'bottom-sell': new Map() };
  const flipped = { cs: cs.map(flipCandle), days: days.map(flipDay) };
  for (const ev of events) {
    const top = ev.kind === 'top';
    const e = top ? ev : unflip(ev); // oriented: bottoms as tops of the mirror
    const sgn = top ? 1 : -1;
    planOrders(top ? cs : flipped.cs, top ? days : flipped.days, e, pp, (branch, day, o) => {
      const strategy: PatternStrategy = top ? (branch === 'rev' ? 'top-sell' : 'top-buy') : branch === 'rev' ? 'bottom-buy' : 'bottom-sell';
      const side: Side = top ? o.side : o.side === 'buy' ? 'sell' : 'buy';
      const cand: Candidate = {
        id: `${symbol}:${strategy}-${ev.second.t}`,
        side,
        line: roundTo(ev.line, digits),
        entry: roundTo(sgn * o.entry, digits),
        sl: roundTo(sgn * o.sl, digits),
        tp: roundTo(sgn * o.tp, digits),
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
