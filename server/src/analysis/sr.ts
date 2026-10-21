import type { Analysis, Candidate, Candle, Line, Side, SrParams } from './types.ts';

export const DEFAULT_SR: SrParams = {
  lookback: 520,
  fractal: 2,
  atrPeriod: 14,
  clusterAtr: 0.5,
  minTouches: 2,
  strongBodyPct: 0.6,
  strongAtr: 0.8,
  strongMaxDistanceAtr: 1,
  strongPick: 'recent',
  wickRatio: 0.5,
  reboundMaxDistanceAtr: 1.5,
  bufferAtr: 0.1,
  autoTpRr: 1.5,
  maxLinesPerSide: 3,
};

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

// Full D1 analysis of one symbol. `candles` must be closed candles in time order;
// `price` is the current mid price (falls back to the last close).
export function analyze(symbol: string, all: Candle[], p: SrParams, digits: number, price?: number): Analysis {
  const candles = all.slice(-p.lookback);
  const last = candles[candles.length - 1];
  if (!last) return { atr: 0, price: price ?? 0, lastCandleAt: 0, lines: [], candidates: [] };
  const a = atr(candles, p.atrPeriod);
  const ref = price ?? last.c;
  const swings = fractals(candles, p.fractal);
  const lines = clusterLines(swings.map((s) => s.price), p.clusterAtr * a, p.minTouches).map((l) => ({
    ...l,
    price: roundTo(l.price, digits),
  }));
  const ctx: Ctx = { candles, swings, lines, atr: a, p, digits, symbol };
  // All lines stay (they are TP targets); the limit only drops far lines' orders.
  const limit = p.maxLinesPerSide > 0 ? p.maxLinesPerSide : Infinity;
  const below = lines.filter((l) => l.price < ref).slice(-limit);
  const above = lines.filter((l) => l.price > ref).slice(0, limit);
  const candidates = dedupeEntries([
    ...below.map((l) => candidateFor(l, 'sell', ctx)),
    ...above.map((l) => candidateFor(l, 'buy', ctx)),
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
