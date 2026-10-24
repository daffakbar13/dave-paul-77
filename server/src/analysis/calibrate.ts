// Compares the user's manual orders with what the engine would have produced on the same
// day, and searches the S/R parameters that reproduce them best. Differences are in ATR
// units so pairs with different price scales can be averaged.
import { analyze, atr, engineLines, fractals, roundTo } from './sr.ts';
import type { Candidate, Candle, Side, SrParams, SymbolData, SymbolInputs } from './types.ts';

export type { SymbolData };

const DAY = 86_400_000;

export type ManualOrder = {
  id: string;
  symbol: string;
  side: Side;
  entry: number;
  sl: number;
  tp: number | null;
  asOf: number; // ms, start of the trading day the order was placed
};


export type Comparison = {
  id: string;
  atr: number;
  auto: Pick<Candidate, 'line' | 'entry' | 'sl' | 'tp' | 'tpAuto'> | null;
  nearestLine: number | null; // S/R line closest to the manual entry
  dEntry: number | null; // (auto - manual) / ATR
  dSl: number | null;
  dTp: number | null;
  match: boolean;
  error: number; // per-order score used for ranking, lower is better
  reason?: string;
};

// An order counts as reproduced when entry and SL land close to the manual ones.
export const MATCH_ENTRY_ATR = 0.2;
export const MATCH_SL_ATR = 0.3;
const MISSING_PENALTY = 3.5;
const cap = (v: number) => Math.min(Math.abs(v), 2);

// Candles available when the order was placed: everything that closed before that day.
export function candlesAsOf(candles: Candle[], asOf: number): Candle[] {
  return candles.filter((c) => c.t < asOf);
}

// Orders of one symbol and day share one analysis; the candle slice is cut once.
type Group = { orders: ManualOrder[]; candles: Candle[] | null; digits: number; inputs: SymbolInputs };

function prepare(orders: ManualOrder[], data: Map<string, SymbolData>): Group[] {
  const map = new Map<string, ManualOrder[]>();
  for (const o of orders) {
    const key = `${o.symbol}|${o.asOf}`;
    map.set(key, [...(map.get(key) ?? []), o]);
  }
  return [...map.values()].map((g) => {
    const d = data.get(g[0]!.symbol);
    return { orders: g, candles: d ? candlesAsOf(d.candles, g[0]!.asOf) : null, digits: d?.digits ?? 5, inputs: d?.inputs ?? {} };
  });
}

const missing = (o: ManualOrder, reason: string, atr = 0): Comparison => ({
  id: o.id, atr, auto: null, nearestLine: null, dEntry: null, dSl: null, dTp: null, match: false, error: MISSING_PENALTY, reason,
});

function compareGroup(g: Group, p: SrParams): Comparison[] {
  const { orders, candles } = g;
  const first = orders[0]!;
  if (!candles) return orders.map((o) => missing(o, 'Belum ada data candle'));
  if (candles.length < 10) {
    return orders.map((o) => missing(o, 'Candle sebelum tanggal ini belum cukup'));
  }
  // every line gets a candidate here; the per-side limit is a display choice, not a level rule
  const a = analyze(first.symbol, candles, { ...p, maxLinesPerSide: 0 }, g.digits, undefined, g.inputs);
  return orders.map((o) => {
    const nearestLine = a.lines.reduce<number | null>(
      (best, l) => (best === null || Math.abs(l.price - o.entry) < Math.abs(best - o.entry) ? l.price : best),
      null,
    );
    const pool = a.candidates.filter((c) => c.side === o.side && c.entry !== undefined);
    const auto = pool.reduce<Candidate | null>(
      (best, c) => (best === null || Math.abs(c.entry! - o.entry) < Math.abs(best.entry! - o.entry) ? c : best),
      null,
    );
    if (!auto) return { ...missing(o, `Tidak ada kandidat ${o.side} stop`, a.atr), nearestLine };
    const dEntry = (auto.entry! - o.entry) / a.atr;
    const dSl = (auto.sl! - o.sl) / a.atr;
    const dTp = o.tp !== null ? (auto.tp! - o.tp) / a.atr : null;
    const match = Math.abs(dEntry) <= MATCH_ENTRY_ATR && Math.abs(dSl) <= MATCH_SL_ATR;
    const error = cap(dEntry) + 0.5 * cap(dSl) + (dTp !== null ? 0.25 * cap(dTp) : 0);
    return {
      id: o.id,
      atr: a.atr,
      auto: { line: auto.line, entry: auto.entry, sl: auto.sl, tp: auto.tp, tpAuto: auto.tpAuto },
      nearestLine,
      dEntry: roundTo(dEntry, 3),
      dSl: roundTo(dSl, 3),
      dTp: dTp === null ? null : roundTo(dTp, 3),
      match,
      error,
    };
  });
}

export type Score = { matched: number; total: number; error: number };

function evaluate(groups: Group[], orders: ManualOrder[], p: SrParams): { rows: Comparison[]; score: Score } {
  const byId = new Map(groups.flatMap((g) => compareGroup(g, p)).map((r) => [r.id, r]));
  const rows = orders.map((o) => byId.get(o.id)!);
  return {
    rows,
    score: {
      matched: rows.filter((r) => r.match).length,
      total: rows.length,
      error: roundTo(rows.reduce((s, r) => s + r.error, 0) / Math.max(rows.length, 1), 4),
    },
  };
}

export function compareAll(orders: ManualOrder[], data: Map<string, SymbolData>, p: SrParams) {
  return evaluate(prepare(orders, data), orders, p);
}

// Values tried by the sweep. Everything else stays at the current settings.
export const LADDER_GRID = {
  entryGap: [0.16, 0.19, 0.22, 0.25, 0.28],
  slGap: [0.1, 0.13, 0.16, 0.19, 0.22],
  tpGap: [0.03, 0.05, 0.07, 0.1],
  clusterAtr: [0.2, 0.3, 0.5],
  minTouches: [1, 2],
};

export const SWEEP_GRID = {
  clusterAtr: [0.3, 0.5, 0.8],
  minTouches: [2, 3],
  strongBodyPct: [0.5, 0.6, 0.7],
  strongAtr: [0.6, 0.8, 1.0],
  strongPick: ['recent', 'nearest'] as const,
  wickRatio: [0.4, 0.5, 0.6],
  bufferAtr: [0.05, 0.1, 0.15],
};

export type SweepResult = { params: Partial<SrParams>; score: Score };

export function sweep(orders: ManualOrder[], data: Map<string, SymbolData>, base: SrParams, top = 5): { current: Score; best: SweepResult[]; tried: number } {
  const prepared = prepare(orders, data);
  const current = evaluate(prepared, orders, base).score;
  const results: SweepResult[] = [];
  const rank = () => {
    results.sort((a, b) => b.score.matched - a.score.matched || a.score.error - b.score.error);
    return { current, best: results.slice(0, top), tried: results.length };
  };
  if (base.orderModel === 'ladder') {
    const l = LADDER_GRID;
    for (const entryGap of l.entryGap)
      for (const slGap of l.slGap)
        for (const tpGap of l.tpGap)
          for (const clusterAtr of l.clusterAtr)
            for (const minTouches of l.minTouches) {
              const params = { entryGap, slGap, tpGap, clusterAtr, minTouches };
              results.push({ params, score: evaluate(prepared, orders, { ...base, ...params }).score });
            }
    return rank();
  }
  const g = SWEEP_GRID;
  for (const clusterAtr of g.clusterAtr)
    for (const minTouches of g.minTouches)
      for (const strongBodyPct of g.strongBodyPct)
        for (const strongAtr of g.strongAtr)
          for (const strongPick of g.strongPick)
            for (const wickRatio of g.wickRatio)
              for (const bufferAtr of g.bufferAtr) {
                const params = { clusterAtr, minTouches, strongBodyPct, strongAtr, strongPick, wickRatio, bufferAtr };
                results.push({ params, score: evaluate(prepared, orders, { ...base, ...params }).score });
              }
  return rank();
}

// --- engine lines vs the user's reference lines ----------------------------------------
// The user's lines are a reference, not the truth: the score shows how close the engine
// gets to them, and the sweep looks for line parameters that reproduce them better.

export const LINE_MATCH_ATR = 0.25; // an engine line within this of a reference line finds it

export type LineFit = {
  symbol: string;
  atr: number;
  engine: number; // engine lines inside the candle range
  reference: number; // reference lines inside the candle range
  matched: number;
  precision: number; // matched / engine
  recall: number; // matched / reference
  f1: number;
};

export type LineScore = { pairs: number; f1: number; precision: number; recall: number };

// One-to-one pairs, closest first, each within `tolerance`.
export function matchLines(engine: number[], reference: number[], tolerance: number): number {
  const pairs: [number, number, number][] = [];
  engine.forEach((e, i) => reference.forEach((r, j) => {
    const d = Math.abs(e - r);
    if (d <= tolerance) pairs.push([d, i, j]);
  }));
  pairs.sort((a, b) => a[0] - b[0]);
  const usedE = new Set<number>();
  const usedR = new Set<number>();
  for (const [, i, j] of pairs) {
    if (usedE.has(i) || usedR.has(j)) continue;
    usedE.add(i);
    usedR.add(j);
  }
  return usedE.size;
}

export function lineFit(symbol: string, d: SymbolData, p: SrParams): LineFit | null {
  const reference = d.inputs?.manualLines ?? [];
  const candles = d.candles.slice(-p.lookback);
  if (!reference.length || candles.length < 10) return null;
  const a = atr(candles, p.atrPeriod);
  const tolerance = LINE_MATCH_ATR * a;
  // lines beyond the candles' range have no swings to find, so neither side counts them
  const low = Math.min(...candles.map((c) => c.l)) - tolerance;
  const high = Math.max(...candles.map((c) => c.h)) + tolerance;
  const inside = (x: number) => x >= low && x <= high;
  const engine = engineLines(candles, fractals(candles, p.fractal), a, p, d.digits).map((l) => l.price).filter(inside);
  const ref = reference.filter(inside);
  const matched = matchLines(engine, ref, tolerance);
  const precision = engine.length ? matched / engine.length : 0;
  const recall = ref.length ? matched / ref.length : 0;
  return {
    symbol,
    atr: a,
    engine: engine.length,
    reference: ref.length,
    matched,
    precision: roundTo(precision, 3),
    recall: roundTo(recall, 3),
    f1: precision + recall ? roundTo((2 * precision * recall) / (precision + recall), 3) : 0,
  };
}

const mean = (xs: number[]) => (xs.length ? roundTo(xs.reduce((s, x) => s + x, 0) / xs.length, 3) : 0);

export function lineFitAll(data: Map<string, SymbolData>, p: SrParams): { fits: LineFit[]; score: LineScore } {
  const fits = [...data].map(([symbol, d]) => lineFit(symbol, d, p)).filter((f): f is LineFit => f !== null);
  return {
    fits,
    score: { pairs: fits.length, f1: mean(fits.map((f) => f.f1)), precision: mean(fits.map((f) => f.precision)), recall: mean(fits.map((f) => f.recall)) },
  };
}

export const LINE_GRID = {
  fractal: [2, 3],
  clusterAtr: [0.3, 0.4, 0.5],
  minTouches: [2, 3],
  rangeWeight: [0, 2, 3],
  minSpacingAtr: [0, 0.4, 0.5],
  zoneMergeAtr: [0, 0.2],
};

export type LineSweepResult = { params: Partial<SrParams>; score: LineScore };

export function lineSweep(data: Map<string, SymbolData>, base: SrParams, top = 5): { current: LineScore; best: LineSweepResult[]; tried: number } {
  const results: LineSweepResult[] = [];
  for (const fractal of LINE_GRID.fractal)
    for (const clusterAtr of LINE_GRID.clusterAtr)
      for (const minTouches of LINE_GRID.minTouches)
        for (const rangeWeight of LINE_GRID.rangeWeight)
          for (const minSpacingAtr of LINE_GRID.minSpacingAtr)
            for (const zoneMergeAtr of LINE_GRID.zoneMergeAtr) {
              const params = { fractal, clusterAtr, minTouches, rangeWeight, minSpacingAtr, zoneMergeAtr };
              results.push({ params, score: lineFitAll(data, { ...base, ...params }).score });
            }
  results.sort((a, b) => b.score.f1 - a.score.f1);
  return { current: lineFitAll(data, base).score, best: results.slice(0, top), tried: results.length };
}
