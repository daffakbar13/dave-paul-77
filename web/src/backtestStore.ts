// What a backtest result is made of once the replay is done, and how it is kept: the
// latest one in IndexedDB (restored when the modal opens) and named ones on the server.
// Trades are kept before money is applied, so balance and risk % can change instantly.
import type { WorkerSymbol } from './backtest.worker.ts';
import type { Coverage, RawTrade } from './engine/backtest.ts';
import type { SrParams } from './engine/types.ts';
import { idbGet, idbSet } from './idb.ts';

export type Fingerprint = { symbol: string; candles: number; first: number | null; last: number | null };

// One replay: what it produced and what it was run with (dates as typed, '' = open end).
export type BtResult = {
  raw: RawTrade[];
  coverage: Coverage[];
  warmup: number;
  sr: SrParams;
  maxCostR?: number; // cost filter of the run (0 / absent = none)
  from: string;
  to: string;
  fingerprint: Fingerprint[];
  saved?: { id: string; name: string }; // loaded from / stored as a named result
};

export type BtUi = { balance: string; risk: string; from: string; to: string; symbol: string; tab: string; excluded: string[] };

const RESULT = 'backtest.result';
const UI = 'backtest.ui';
const CANDLES = 'backtest.candles';

// kept apart: the inputs change often, the result (MBs) only after a run or a load
export const loadLastResult = () => idbGet<BtResult>(RESULT);
export const saveLastResult = (r: BtResult) => idbSet(RESULT, r);
export const loadUi = () => idbGet<BtUi>(UI);
export const saveUi = (ui: BtUi) => idbSet(UI, ui);

// The candles of the last download, for the Chart tab, so it does not fetch them again.
export const loadCandles = () => idbGet<WorkerSymbol[]>(CANDLES);
export const saveCandles = (symbols: WorkerSymbol[]) => idbSet(CANDLES, symbols);

export const fingerprintOf = (symbols: WorkerSymbol[]): Fingerprint[] =>
  symbols.map((s) => ({ symbol: s.name, candles: s.candles.length, first: s.candles[0]?.[0] ?? null, last: s.candles[s.candles.length - 1]?.[0] ?? null }));

// Same S/R settings? Keys missing on one side count as different.
export function sameSr(a: SrParams, b: SrParams): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof SrParams>;
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  return true;
}

// --- compact form for the server -----------------------------------------------------
// [symbol, side, entryAt, exitAt, entry, tp, sl, result, tpPips, slPips, pips, r, ambiguous, digits]
export type CompactTrade = (string | number | boolean | null)[];

const CODE = { TP: 'T', SL: 'S', Open: 'O' } as const;
const RESULT_BACK = { T: 'TP', S: 'SL', O: 'Open' } as const;

export const pack = (t: RawTrade): CompactTrade => [
  t.symbol, t.side === 'buy' ? 'b' : 's', t.entryAt, t.exitAt, t.entry, t.tp, t.sl, CODE[t.result], t.tpPips, t.slPips, t.pips, t.r, t.ambiguous, t.digits,
];

export function unpack(a: CompactTrade): RawTrade {
  const [symbol, side, entryAt, exitAt, entry, tp, sl, result, tpPips, slPips, pips, r, ambiguous, digits] = a;
  return {
    symbol: symbol as string,
    side: side === 'b' ? 'buy' : 'sell',
    entryAt: entryAt as number,
    exitAt: exitAt as number | null,
    entry: entry as number,
    tp: tp as number,
    sl: sl as number,
    result: RESULT_BACK[result as keyof typeof RESULT_BACK],
    tpPips: tpPips as number,
    slPips: slPips as number,
    pips: pips as number,
    r: r as number,
    ambiguous: ambiguous as boolean,
    digits: digits as number,
  };
}
