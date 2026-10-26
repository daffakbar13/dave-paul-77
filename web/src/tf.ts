import type { OrderRow } from './api.ts';

// Traders Family copy-signal limits (reward system PDF, in force since 2026-03-01).
// Pip sizes: JPY pairs 0.01, XAUUSD 0.1, the rest 0.0001.
type Group = { minPips: number; maxPips: number; gap: number };

const G1: Group = { minPips: 10, maxPips: 200, gap: 50 };
const G2: Group = { minPips: 15, maxPips: 300, gap: 75 };
const G3: Group = { minPips: 20, maxPips: 400, gap: 100 };
const GOLD: Group = { minPips: 30, maxPips: 500, gap: 100 };

const GROUPS: Record<string, Group> = {
  NZDUSD: G1, AUDUSD: G1, EURGBP: G1, USDCHF: G1,
  USDCAD: G2, EURUSD: G2, GBPUSD: G2, NZDJPY: G2, CADJPY: G2, AUDJPY: G2,
  CHFJPY: G3, USDJPY: G3, EURJPY: G3, GBPJPY: G3, EURNZD: G3,
  XAUUSD: GOLD,
};

// Value Pair multiplier for Valued Pips (VP = pips x value).
const VALUE: Record<string, number> = {
  NZDUSD: 2, AUDUSD: 2, EURGBP: 2, USDCHF: 2,
  USDCAD: 1.5, EURUSD: 1.5, GBPUSD: 1.5, NZDJPY: 1.5, CADJPY: 1.5, AUDJPY: 1.5,
  CHFJPY: 1, EURNZD: 1, USDJPY: 1, EURJPY: 1, GBPJPY: 1,
  XAUUSD: 0.2,
};

export const MAX_RR = 3;

export const pipSize = (symbol: string) => (symbol.startsWith('XAU') ? 0.1 : symbol.includes('JPY') ? 0.01 : 0.0001);
export const tfKnown = (symbol: string) => symbol in GROUPS;
export const valuePair = (symbol: string) => VALUE[symbol] ?? null;

export type SignalRow = {
  id: string;
  symbol: string;
  type: OrderRow['type'];
  entry: number;
  sl: number;
  tp: number;
  slPips: number;
  tpPips: number;
  rr: number;
  vp: number | null; // Valued Pips if TP is hit
  problems: string[];
};

const round1 = (v: number) => Math.round(v * 10) / 10;

// Valid app orders as TF signals, with every limit that would make TF reject one.
export function toSignals(rows: OrderRow[]): SignalRow[] {
  const out: SignalRow[] = [];
  const valid = rows.filter((r) => r.status === 'valid' && r.entry !== null && r.sl !== null && r.tp !== null);
  const symbols = [...new Set(valid.map((r) => r.symbol))].sort();
  for (const symbol of symbols) {
    const pip = pipSize(symbol);
    const group = GROUPS[symbol];
    const list = valid.filter((r) => r.symbol === symbol).sort((a, b) => a.entry! - b.entry!);
    const lastEntry: Partial<Record<OrderRow['side'], number>> = {};
    for (const r of list) {
      const slPips = round1(Math.abs(r.entry! - r.sl!) / pip);
      const tpPips = round1(Math.abs(r.tp! - r.entry!) / pip);
      const rr = slPips > 0 ? tpPips / slPips : 0;
      const value = VALUE[symbol] ?? null;
      const problems: string[] = [];
      if (!group) problems.push('Pair tidak ada di aturan TF');
      else {
        if (slPips < group.minPips) problems.push(`SL ${slPips} < min ${group.minPips} pips`);
        if (slPips > group.maxPips) problems.push(`SL ${slPips} > maks ${group.maxPips} pips`);
        if (tpPips < group.minPips) problems.push(`TP ${tpPips} < min ${group.minPips} pips`);
        if (tpPips > group.maxPips) problems.push(`TP ${tpPips} > maks ${group.maxPips} pips`);
        const prev = lastEntry[r.side];
        if (prev !== undefined) {
          const gap = round1(Math.abs(r.entry! - prev) / pip);
          if (gap < group.gap) problems.push(`Selisih ke signal sebelumnya ${gap} < ${group.gap} pips`);
        }
      }
      if (rr > MAX_RR + 1e-9) problems.push(`RR 1:${rr.toFixed(1)} melebihi 1:${MAX_RR}`);
      lastEntry[r.side] = r.entry!;
      out.push({
        id: r.id, symbol, type: r.type, entry: r.entry!, sl: r.sl!, tp: r.tp!, slPips, tpPips, rr,
        vp: value === null ? null : round1(tpPips * value), problems,
      });
    }
  }
  return out;
}
