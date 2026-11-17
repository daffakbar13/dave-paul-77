import type { OrderRow, TfOrder } from './api.ts';
import { tr } from './i18n.ts';

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
  side: OrderRow['side'];
  type: OrderRow['type'];
  entry: number;
  sl: number;
  tp: number;
  slPips: number;
  tpPips: number;
  rr: number;
  vp: number | null; // Valued Pips if TP is hit
  riskVp: number | null; // Valued Pips if SL is hit
  problems: string[];
};

const round1 = (v: number) => Math.round(v * 10) / 10;

// Pips, RR, Valued Pips and every per-signal limit that would make TF reject it.
// The gap between two signals on one side is TF's own check against signals already
// sent, so it is not repeated here.
export function tfCheck(symbol: string, entry: number, sl: number, tp: number) {
  const pip = pipSize(symbol);
  const group = GROUPS[symbol];
  const slPips = round1(Math.abs(entry - sl) / pip);
  const tpPips = round1(Math.abs(tp - entry) / pip);
  const rr = slPips > 0 ? tpPips / slPips : 0;
  const value = VALUE[symbol] ?? null;
  const problems: string[] = [];
  if (!group) problems.push(tr('Pair tidak ada di aturan TF', 'Pair is not in the TF rules'));
  else {
    if (slPips < group.minPips) problems.push(`SL ${slPips} < min ${group.minPips} pips`);
    if (slPips > group.maxPips) problems.push(tr(`SL ${slPips} > maks ${group.maxPips} pips`, `SL ${slPips} > max ${group.maxPips} pips`));
    if (tpPips < group.minPips) problems.push(`TP ${tpPips} < min ${group.minPips} pips`);
    if (tpPips > group.maxPips) problems.push(tr(`TP ${tpPips} > maks ${group.maxPips} pips`, `TP ${tpPips} > max ${group.maxPips} pips`));
  }
  if (rr > MAX_RR + 1e-9) problems.push(tr(`RR 1:${rr.toFixed(1)} melebihi 1:${MAX_RR}`, `RR 1:${rr.toFixed(1)} exceeds 1:${MAX_RR}`));
  return {
    slPips,
    tpPips,
    rr,
    vp: value === null ? null : round1(tpPips * value),
    riskVp: value === null ? null : round1(slPips * value),
    problems,
  };
}

// One buy stop and one sell stop per pair, pairs A-Z, buy before sell: the stop nearest
// price on each side, i.e. the lowest buy stop and the highest sell stop (the server only
// sends stops still on their side of price, so no quote is needed here).
export function nearestSignals(rows: TfOrder[]): SignalRow[] {
  const out: SignalRow[] = [];
  const symbols = [...new Set(rows.map((r) => r.symbol))].sort((a, b) => a.localeCompare(b));
  for (const symbol of symbols) {
    for (const side of ['buy', 'sell'] as const) {
      const mine = rows.filter((r) => r.symbol === symbol && r.side === side);
      const r = mine.sort((a, b) => (side === 'buy' ? a.entry - b.entry : b.entry - a.entry))[0];
      if (!r) continue;
      out.push({ id: r.id, symbol, side, type: r.type, entry: r.entry, sl: r.sl, tp: r.tp, ...tfCheck(symbol, r.entry, r.sl, r.tp) });
    }
  }
  return out;
}
