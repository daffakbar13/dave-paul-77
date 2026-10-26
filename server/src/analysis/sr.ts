import type { Analysis, Candidate, Candle, Line, Side, SrParams, SymbolInputs } from './types.ts';

export const DEFAULT_SR: SrParams = {
  lineSource: 'auto',
  lookback: 520,
  fractal: 2,
  atrPeriod: 14,
  // fitted to the user's lines on 13 pairs (Oct 2026): swings alone gave F1 0.51
  clusterAtr: 0.4,
  minTouches: 2,
  rangeMinBars: 5,
  rangeMaxAtr: 2,
  rangeWeight: 2,
  // one reaction area = one line (the user's CHFJPY 198-199.4 zone, Oct 2026); F1 0.58
  minSpacingAtr: 0.4,
  zoneMergeAtr: 0.2,
  strongBodyPct: 0.6,
  strongAtr: 0.8,
  strongMaxDistanceAtr: 1,
  strongPick: 'recent',
  wickRatio: 0.5,
  reboundMaxDistanceAtr: 1.5,
  bufferAtr: 0.1,
  autoTpRr: 1.5,
  maxLinesPerSide: 6,
  // fitted to 3,648 of the user's manual orders against their own lines (Sep 2026):
  // medians 0.22 / 0.16 / 0.07 of the gap, RR about 1.9 at any line spacing
  orderModel: 'ladder',
  entryGap: 0.22,
  slGap: 0.16,
  tpGap: 0.07,
  minDistanceAtr: 0.15,
  // the user's own SLs sit ~0.38 ATR from entry, tighter than any D1 candle low allows, so
  // the candle SL is an option rather than the default
  slSource: 'ladder',
  slStrongAtr: 0.3,
  slMaxRiskAtr: 0.6,
};

// 1 pip = 10 points on 5/3-digit FX and 2-digit gold (0.1).
export function pipSize(digits: number): number {
  return digits === 2 || digits === 3 || digits === 5 ? 10 * 10 ** -digits : 10 ** -digits;
}

export function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// Wilder's ATR of the last candle. Fewer candles than the period gives the plain average.
export function atr(candles: Candle[], period: number): number {
  if (candles.length < 2) return candles[0] ? candles[0].h - candles[0].l : 0;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!.c;
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev)));
  }
  if (tr.length <= period) return tr.reduce((a, b) => a + b, 0) / tr.length;
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]!) / period;
  return value;
}

export type Swing = { i: number; price: number; kind: 'high' | 'low' };

// A swing high is higher than `n` candles on each side (strictly); a swing low mirrors it.
export function fractals(candles: Candle[], n: number): Swing[] {
  const swings: Swing[] = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= n; k++) {
      const left = candles[i - k]!;
      const right = candles[i + k]!;
      if (!(c.h > left.h && c.h > right.h)) isHigh = false;
      if (!(c.l < left.l && c.l < right.l)) isLow = false;
    }
    if (isHigh) swings.push({ i, price: c.h, kind: 'high' });
    if (isLow) swings.push({ i, price: c.l, kind: 'low' });
  }
  return swings;
}

// Sorted prices are grouped while the group stays within `tolerance` of its first price,
// so a chain of close swings cannot stretch one area across the whole chart.
export function clusterLines(prices: number[], tolerance: number, minTouches: number): Line[] {
  const sorted = [...prices].sort((a, b) => a - b);
  const lines: Line[] = [];
  let group: number[] = [];
  const flush = () => {
    if (group.length >= minTouches) {
      const sum = group.reduce((a, b) => a + b, 0);
      lines.push({ price: sum / group.length, touches: group.length, low: group[0]!, high: group[group.length - 1]! });
    }
    group = [];
  };
  for (const p of sorted) {
    if (group.length && p - group[0]! > tolerance) flush();
    group.push(p);
  }
  flush();
  return lines;
}

type Ctx = {
  inputs: SymbolInputs;
  ref: number;
  candles: Candle[];
  swings: Swing[];
  lines: Line[];
  atr: number;
  p: SrParams;
  digits: number;
  symbol: string;
};

function body(c: Candle) {
  return Math.abs(c.c - c.o);
}

function isStrong(c: Candle, side: Side, ctx: Ctx): boolean {
  const range = c.h - c.l;
  if (range <= 0) return false;
  const directional = side === 'buy' ? c.c > c.o : c.c < c.o;
  return directional && body(c) >= ctx.p.strongBodyPct * range && body(c) >= ctx.p.strongAtr * ctx.atr;
}

// Strong candle that broke through the line, close to it. Buy: high above R; sell: low below S.
function findStrong(line: number, side: Side, ctx: Ctx): number | undefined {
  const band = ctx.p.strongMaxDistanceAtr * ctx.atr;
  let best: number | undefined;
  ctx.candles.forEach((c, i) => {
    if (!isStrong(c, side, ctx)) return;
    const crosses = side === 'buy' ? c.h > line && c.l < line + band : c.l < line && c.h > line - band;
    if (!crosses) return;
    if (best === undefined) {
      best = i;
      return;
    }
    if (ctx.p.strongPick === 'recent') best = i;
    else {
      const prev = ctx.candles[best]!;
      const nearer = side === 'buy' ? c.h < prev.h : c.l > prev.l;
      if (nearer) best = i;
    }
  });
  return best;
}

// Nearest rebound on the other side of the line: a fractal swing or a rejection wick.
// Buy: the highest low below R; sell: the lowest high above S.
function findRebound(line: number, side: Side, ctx: Ctx): number | undefined {
  const band = ctx.p.reboundMaxDistanceAtr * ctx.atr;
  const swingIdx = new Set(ctx.swings.filter((s) => s.kind === (side === 'buy' ? 'low' : 'high')).map((s) => s.i));
  let best: number | undefined;
  ctx.candles.forEach((c, i) => {
    const range = c.h - c.l;
    const wick = side === 'buy' ? Math.min(c.o, c.c) - c.l : c.h - Math.max(c.o, c.c);
    const rejection = range > 0 && wick >= ctx.p.wickRatio * range;
    if (!swingIdx.has(i) && !rejection) return;
    const price = side === 'buy' ? c.l : c.h;
    const inside = side === 'buy' ? price < line && price >= line - band : price > line && price <= line + band;
    if (!inside) return;
    if (best === undefined) {
      best = i;
      return;
    }
    const prev = ctx.candles[best]!;
    const nearer = side === 'buy' ? c.l > prev.l : c.h < prev.h;
    if (nearer) best = i;
  });
  return best;
}

function candidateFor(line: Line, side: Side, ctx: Ctx): Candidate {
  const id = `${ctx.symbol}:${side}-${line.price.toFixed(ctx.digits)}`;
  const base: Candidate = { id, side, line: roundTo(line.price, ctx.digits) };
  const strongI = findStrong(line.price, side, ctx);
  const reboundI = findRebound(line.price, side, ctx);
  if (strongI === undefined && reboundI === undefined) return { ...base, skipped: 'Candle kuat dan pantulan tidak ditemukan' };
  if (strongI === undefined) return { ...base, skipped: 'Candle kuat tidak ditemukan' };
  if (reboundI === undefined) return { ...base, skipped: 'Pantulan tidak ditemukan' };

  const buffer = ctx.p.bufferAtr * ctx.atr;
  const strong = ctx.candles[strongI]!;
  const rebound = ctx.candles[reboundI]!;
  // rounded first so an auto TP shows exactly the configured RR
  const entry = roundTo(side === 'buy' ? strong.h + buffer : strong.l - buffer, ctx.digits);
  const sl = roundTo(side === 'buy' ? rebound.l - buffer : rebound.h + buffer, ctx.digits);
  const risk = Math.abs(entry - sl);

  // TP is the next line beyond the entry; at ATH/ATL fall back to a fixed RR.
  const next = side === 'buy'
    ? ctx.lines.find((l) => l.price > entry)
    : [...ctx.lines].reverse().find((l) => l.price < entry);
  const tpAuto = !next;
  const tp = next ? next.price : side === 'buy' ? entry + ctx.p.autoTpRr * risk : entry - ctx.p.autoTpRr * risk;

  return {
    ...base,
    entry,
    sl,
    tp: roundTo(tp, ctx.digits),
    tpAuto,
    strongAt: strong.t,
    reboundAt: rebound.t,
  };
}

// Ladder model: entry beyond the line, SL across the same line, TP just before the next
// line, all scaled by the gap g to that next line (or the previous one at the edge).
function ladderCandidate(line: Line, side: Side, ctx: Ctx): Candidate {
  const id = `${ctx.symbol}:${side}-${line.price.toFixed(ctx.digits)}`;
  const base: Candidate = { id, side, line: roundTo(line.price, ctx.digits) };
  const sg = side === 'buy' ? 1 : -1;
  const beyond = ctx.lines.filter((l) => sg * (l.price - line.price) > 0).sort((a, b) => sg * (a.price - b.price));
  const behind = ctx.lines.filter((l) => sg * (l.price - line.price) < 0).sort((a, b) => sg * (b.price - a.price));
  const next = beyond[0];
  const g = next ? Math.abs(next.price - line.price) : behind[0] ? Math.abs(line.price - behind[0].price) : ctx.atr;

  const entry = roundTo(line.price + sg * ctx.p.entryGap * g, ctx.digits);
  const buffer = ctx.p.bufferAtr * ctx.atr;
  const strongI = ctx.p.slSource === 'candle' ? findStrongBehind(line.price, side, ctx) : undefined;
  const candleSl = strongI === undefined ? undefined : roundTo(side === 'buy' ? ctx.candles[strongI]!.l - buffer : ctx.candles[strongI]!.h + buffer, ctx.digits);
  // too wide a candle SL wrecks the RR against the ladder TP: keep the ladder SL instead
  const strong = candleSl !== undefined && Math.abs(entry - candleSl) <= ctx.p.slMaxRiskAtr * ctx.atr ? ctx.candles[strongI!] : undefined;
  let sl = strong ? candleSl! : roundTo(line.price - sg * ctx.p.slGap * g, ctx.digits);
  const minSl = (ctx.inputs.minSlPips ?? 0) * pipSize(ctx.digits);
  if (Math.abs(entry - sl) < minSl) sl = roundTo(entry - sg * minSl, ctx.digits);
  const risk = Math.abs(entry - sl);
  const tp = roundTo(next ? next.price - sg * ctx.p.tpGap * g : entry + sg * ctx.p.autoTpRr * risk, ctx.digits);
  if (sg * (tp - entry) <= 0) return { ...base, skipped: 'Garis berikutnya terlalu dekat untuk TP' };
  return { ...base, entry, sl, tp, tpAuto: !next, slFrom: strong ? 'candle' : 'ladder', ...(strong ? { reboundAt: strong.t } : {}) };
}

// Strong D1 candle in the order direction sitting on the SL side of the line: for a buy
// stop a bullish candle below the resistance (close still under it, high within the band),
// mirrored for a sell stop above the support. The nearest one wins: the highest low for a
// buy (lowest high for a sell), i.e. the tightest SL.
function findStrongBehind(line: number, side: Side, ctx: Ctx): number | undefined {
  const band = ctx.p.strongMaxDistanceAtr * ctx.atr;
  let best: number | undefined;
  ctx.candles.forEach((c, i) => {
    const range = c.h - c.l;
    const body = Math.abs(c.c - c.o);
    const directional = side === 'buy' ? c.c > c.o : c.c < c.o;
    if (!directional || range <= 0 || body < ctx.p.strongBodyPct * range || body < ctx.p.slStrongAtr * ctx.atr) return;
    const behind = side === 'buy' ? c.c < line && c.h >= line - band : c.c > line && c.l <= line + band;
    if (!behind) return;
    const prev = best === undefined ? undefined : ctx.candles[best]!;
    if (!prev || (side === 'buy' ? c.l > prev.l : c.h < prev.h)) best = i;
  });
  return best;
}

// ATR at every candle (Wilder), so an old range is measured against the volatility of its time.
export function atrSeries(candles: Candle[], period: number): number[] {
  const out: number[] = [];
  let value = 0;
  candles.forEach((c, i) => {
    const prev = candles[i - 1];
    const tr = prev ? Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)) : c.h - c.l;
    value = i < period ? (value * i + tr) / (i + 1) : (value * (period - 1) + tr) / period;
    out.push(value);
  });
  return out;
}

export type Range = { from: number; to: number; top: number; bottom: number };

// Sideways areas: at least `rangeMinBars` candles whose highs and lows stay within
// `rangeMaxAtr` x ATR. Scanned left to right, each range as long as it can grow.
export function ranges(candles: Candle[], atrs: number[], p: SrParams): Range[] {
  const out: Range[] = [];
  let i = 0;
  while (i < candles.length) {
    const limit = p.rangeMaxAtr * atrs[i]!;
    let top = candles[i]!.h;
    let bottom = candles[i]!.l;
    let j = i + 1;
    for (; j < candles.length; j++) {
      const t = Math.max(top, candles[j]!.h);
      const b = Math.min(bottom, candles[j]!.l);
      if (t - b > limit) break;
      top = t;
      bottom = b;
    }
    if (j - i >= p.rangeMinBars) {
      out.push({ from: i, to: j - 1, top, bottom });
      i = j;
    } else i++;
  }
  return out;
}

// The price on one edge of a range where most candles turned: the level that lies between
// the body edge and the wick tip (± tolerance) of the most candles. Many bodies stopping at
// one price put it on the bodies; wicks poking to one price put it on the wicks.
export function rangeEdge(candles: Candle[], r: Range, kind: 'top' | 'bottom', tolerance: number): { price: number; turns: number } {
  const box = candles.slice(r.from, r.to + 1);
  const zone = (r.top - r.bottom) / 3;
  const tip = (c: Candle) => (kind === 'top' ? c.h : c.l);
  const bodyEdge = (c: Candle) => (kind === 'top' ? Math.max(c.o, c.c) : Math.min(c.o, c.c));
  const inZone = (x: number) => (kind === 'top' ? x >= r.top - zone : x <= r.bottom + zone);
  const levels = box.flatMap((c) => [tip(c), bodyEdge(c)]).filter(inZone);
  let best = { price: kind === 'top' ? r.top : r.bottom, turns: 0 };
  for (const x of levels) {
    const turns = box.filter((c) => {
      const lo = Math.min(tip(c), bodyEdge(c)) - tolerance;
      const hi = Math.max(tip(c), bodyEdge(c)) + tolerance;
      return x >= lo && x <= hi;
    }).length;
    // ties go to the price further out, the edge price had to break
    const further = kind === 'top' ? x > best.price : x < best.price;
    if (turns > best.turns || (turns === best.turns && further)) best = { price: x, turns };
  }
  return best;
}

// The engine's own lines. Swing highs/lows count 1 each and range edges `rangeWeight`
// each; prices within `clusterAtr` form one line, kept when its weight reaches
// `minTouches`. Lines of one reaction area are then merged (mergeClose).
export function engineLines(candles: Candle[], swings: Swing[], atrValue: number, p: SrParams, digits: number): Line[] {
  const atrs = atrSeries(candles, p.atrPeriod);
  const points = swings.map((s) => ({ price: s.price, weight: 1, range: false }));
  for (const r of p.rangeWeight > 0 ? ranges(candles, atrs, p) : []) {
    const tolerance = 0.1 * atrs[r.from]!;
    for (const kind of ['top', 'bottom'] as const) {
      const edge = rangeEdge(candles, r, kind, tolerance);
      if (edge.turns >= 2) points.push({ price: edge.price, weight: p.rangeWeight, range: true });
    }
  }
  points.sort((a, b) => a.price - b.price);
  const tolerance = p.clusterAtr * atrValue;
  const lines: Line[] = [];
  let group: typeof points = [];
  const flush = () => {
    const weight = group.reduce((s, x) => s + x.weight, 0);
    if (group.length && weight >= p.minTouches) {
      const price = group.reduce((s, x) => s + x.price * x.weight, 0) / weight;
      lines.push({
        price: roundTo(price, digits),
        touches: group.filter((x) => !x.range).length,
        ranges: group.filter((x) => x.range).length,
        strength: weight,
        low: group[0]!.price,
        high: group[group.length - 1]!.price,
        source: 'auto',
      });
    }
    group = [];
  };
  for (const x of points) {
    if (group.length && x.price - group[0]!.price > tolerance) flush();
    group.push(x);
  }
  flush();
  if (!(p.minSpacingAtr > 0) && !(p.zoneMergeAtr > 0)) return lines;
  return mergeClose(lines, candles, p.minSpacingAtr * atrValue, p.zoneMergeAtr * atrValue, p.rangeMaxAtr * atrValue, digits);
}

// Of the candles touching the band between two lines, the share whose whole body sits
// inside it. A box price traded in scores high; a zone price only poked into scores low.
export function bodiesBetween(candles: Candle[], low: number, high: number): number {
  const touching = candles.filter((c) => c.h >= low && c.l <= high);
  if (!touching.length) return 0;
  return touching.filter((c) => Math.min(c.o, c.c) >= low && Math.max(c.o, c.c) <= high).length / touching.length;
}

export const ZONE_BODY_SHARE = 0.1;

// One reaction area should give one line: two neighbouring lines become one line at their
// strength-weighted average when closer than `spacing`, or when their nearest swings are
// closer than `zone` while price never traded between them (bodiesBetween below
// ZONE_BODY_SHARE). Closest pair first; a merged zone stays within `maxZone`.
export function mergeClose(lines: Line[], candles: Candle[], spacing: number, zone: number, maxZone: number, digits: number): Line[] {
  const out = [...lines].sort((a, b) => a.price - b.price);
  const joins = (a: Line, b: Line) => {
    if (b.price - a.price < spacing) return true;
    return b.low - a.high < zone && b.high - a.low <= maxZone && bodiesBetween(candles, a.price, b.price) < ZONE_BODY_SHARE;
  };
  for (;;) {
    let at = -1;
    for (let i = 1; i < out.length; i++) {
      const gap = out[i]!.price - out[i - 1]!.price;
      if ((at < 0 || gap < out[at]!.price - out[at - 1]!.price) && joins(out[i - 1]!, out[i]!)) at = i;
    }
    if (at < 0) return out;
    const a = out[at - 1]!;
    const b = out[at]!;
    const sa = a.strength ?? 1;
    const sb = b.strength ?? 1;
    out.splice(at - 1, 2, {
      price: roundTo((a.price * sa + b.price * sb) / (sa + sb), digits),
      touches: a.touches + b.touches,
      ranges: (a.ranges ?? 0) + (b.ranges ?? 0),
      strength: sa + sb,
      low: Math.min(a.low, b.low),
      high: Math.max(a.high, b.high),
      source: a.source,
    });
  }
}

// Full D1 analysis of one symbol. `candles` must be closed candles in time order;
// `price` is the current mid price (falls back to the last close).
export function analyze(symbol: string, all: Candle[], p: SrParams, digits: number, price?: number, inputs: SymbolInputs = {}): Analysis {
  const candles = all.slice(-p.lookback);
  const last = candles[candles.length - 1];
  if (!last) return { atr: 0, price: price ?? 0, lastCandleAt: 0, lines: [], candidates: [] };
  const a = atr(candles, p.atrPeriod);
  const ref = price ?? last.c;
  const swings = fractals(candles, p.fractal);
  // the engine's lines by default; the user's lines replace them only when asked to
  const lines: Line[] = p.lineSource === 'manual' && inputs.manualLines?.length
    ? [...new Set(inputs.manualLines.map((x) => roundTo(x, digits)))]
        .sort((x, y) => x - y)
        .map((x) => ({ price: x, touches: 0, low: x, high: x, source: 'manual' }))
    : engineLines(candles, swings, a, p, digits);
  const ctx: Ctx = { inputs, ref, candles, swings, lines, atr: a, p, digits, symbol };
  // All lines stay (they are TP targets); the limit only drops far lines' orders. Orders
  // whose entry is too close to price are listed as skipped and do not use up the limit.
  const limit = p.maxLinesPerSide > 0 ? p.maxLinesPerSide : Infinity;
  const make = (l: Line, side: Side): Candidate => {
    const c = (p.orderModel === 'ladder' ? ladderCandidate : candidateFor)(l, side, ctx);
    return c.entry !== undefined && Math.abs(c.entry - ref) < p.minDistanceAtr * a ? { id: c.id, side, line: c.line, skipped: 'Terlalu dekat harga' } : c;
  };
  const pick = (side: Line[], kind: Side) => {
    let kept = 0;
    return side.map((l) => make(l, kind)).filter((c) => c.skipped === 'Terlalu dekat harga' || kept++ < limit);
  };
  const below = pick(lines.filter((l) => l.price < ref).reverse(), 'sell');
  const above = pick(lines.filter((l) => l.price > ref), 'buy');
  const candidates = dedupeEntries([
    ...below.reverse(),
    ...above,
  ]);
  return { atr: a, price: ref, lastCandleAt: last.t, lines, candidates };
}

// Close lines can share one strong candle and so one entry. Only the line nearest that
// entry keeps the order; the others stay visible as skipped so no price gets two orders.
function dedupeEntries(candidates: Candidate[]): Candidate[] {
  const keeper = new Map<string, Candidate>();
  for (const c of candidates) {
    if (c.entry === undefined) continue;
    const key = `${c.side}:${c.entry}`;
    const best = keeper.get(key);
    if (!best || Math.abs(c.line - c.entry) < Math.abs(best.line - best.entry!)) keeper.set(key, c);
  }
  return candidates.map((c) => {
    if (c.entry === undefined) return c;
    const best = keeper.get(`${c.side}:${c.entry}`)!;
    if (best === c) return c;
    return { id: c.id, side: c.side, line: c.line, skipped: `Entry sama dengan garis ${best.line}` };
  });
}
