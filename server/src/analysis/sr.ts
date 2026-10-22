import type { Analysis, Candidate, Candle, Line, Side, SrParams, SymbolInputs } from './types.ts';

export const DEFAULT_SR: SrParams = {
  lineSource: 'auto',
  lookback: 520,
  fractal: 2,
  atrPeriod: 14,
  clusterAtr: 0.3, // best match with the user's own lines (Sep 2026 templates)
  minTouches: 2,
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
  minDistanceAtr: 0.3,
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
  if (Math.abs(line.price - ctx.ref) < ctx.p.minDistanceAtr * ctx.atr) return { ...base, skipped: 'Terlalu dekat harga' };
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

// Full D1 analysis of one symbol. `candles` must be closed candles in time order;
// `price` is the current mid price (falls back to the last close).
// The engine's own lines: swing highs and lows grouped by `clusterAtr`, kept with `minTouches`.
export function engineLines(swings: Swing[], atrValue: number, p: SrParams, digits: number): Line[] {
  return clusterLines(swings.map((s) => s.price), p.clusterAtr * atrValue, p.minTouches).map((l) => ({
    ...l,
    price: roundTo(l.price, digits),
    source: 'auto',
  }));
}

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
    : engineLines(swings, a, p, digits);
  const ctx: Ctx = { inputs, ref, candles, swings, lines, atr: a, p, digits, symbol };
  // All lines stay (they are TP targets); the limit only drops far lines' orders. Lines
  // too close to price are listed as skipped and do not use up the limit.
  const limit = p.maxLinesPerSide > 0 ? p.maxLinesPerSide : Infinity;
  const near = (l: Line) => Math.abs(l.price - ref) < p.minDistanceAtr * a;
  const pick = (side: Line[]) => [...side.filter(near), ...side.filter((l) => !near(l)).slice(0, limit)];
  const below = pick(lines.filter((l) => l.price < ref).reverse());
  const above = pick(lines.filter((l) => l.price > ref));
  const make = p.orderModel === 'ladder' ? ladderCandidate : candidateFor;
  const candidates = dedupeEntries([
    ...below.reverse().map((l) => make(l, 'sell', ctx)),
    ...above.map((l) => make(l, 'buy', ctx)),
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
