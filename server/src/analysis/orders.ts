import { roundTo } from './sr.ts';
import type { Candidate, Side, SymbolSpec } from './types.ts';

export type RowStatus = 'valid' | 'skipped' | 'invalid' | 'cancelled';

export type OrderRow = {
  id: string;
  symbol: string;
  side: Side;
  type: 'buy stop' | 'sell stop';
  line: number;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  tpAuto: boolean;
  lot: number | null;
  risk: number | null; // account currency, after lot rounding
  rr: number | null;
  lowRr: boolean;
  multiplier: number; // 1, or the account's Aggressive multiplier
  status: RowStatus;
  reason?: string;
};

export type Quote = { bid: number; ask: number };

export type EvalInput = {
  symbol: string;
  candidate: Candidate;
  cancelled: boolean;
  spec: SymbolSpec | undefined;
  quote: Quote | undefined;
  balance: number;
  riskPct: number;
  multiplier: number;
  rrThreshold: number;
  offset: number; // MT5 price minus MT4 price for this symbol
};

function decimals(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

// Lot from money at risk, rounded DOWN to the broker's volume step so the risk never
// exceeds the target. Returns the lot actually used and the money it risks.
export function sizeLot(riskMoney: number, entry: number, sl: number, spec: SymbolSpec): { lot: number; risk: number } {
  const ticks = Math.abs(entry - sl) / spec.tickSize;
  const lossPerLot = ticks * spec.tickValue;
  if (!(lossPerLot > 0) || !(riskMoney > 0)) return { lot: 0, risk: 0 };
  const raw = riskMoney / lossPerLot;
  // the epsilon keeps 0.3 / 0.01 = 29.999999 from losing a step
  const steps = Math.floor(raw / spec.volumeStep + 1e-9);
  const lot = roundTo(Math.min(steps * spec.volumeStep, spec.volumeMax), decimals(spec.volumeStep));
  return { lot, risk: roundTo(lot * lossPerLot, 2) };
}

export function evaluate(input: EvalInput): OrderRow {
  const { candidate: c, spec, quote, offset } = input;
  const shift = (v: number | undefined) => (v === undefined ? null : roundTo(v + offset, spec?.digits ?? 5));
  const row: OrderRow = {
    id: c.id,
    symbol: input.symbol,
    side: c.side,
    type: c.side === 'buy' ? 'buy stop' : 'sell stop',
    line: c.line,
    entry: shift(c.entry),
    sl: shift(c.sl),
    tp: shift(c.tp),
    tpAuto: !!c.tpAuto,
    lot: null,
    risk: null,
    rr: null,
    lowRr: false,
    multiplier: input.multiplier,
    status: 'valid',
  };
  if (c.skipped || row.entry === null || row.sl === null || row.tp === null) {
    return { ...row, status: 'skipped', reason: c.skipped ?? 'Level tidak lengkap' };
  }
  const entry = row.entry;
  const sl = row.sl;
  const tp = row.tp;
  row.rr = roundTo(Math.abs(tp - entry) / Math.abs(entry - sl), 2);
  row.lowRr = row.rr < input.rrThreshold;

  if (spec) {
    const { lot, risk } = sizeLot((input.balance * input.riskPct * input.multiplier) / 100, entry, sl, spec);
    row.lot = lot;
    row.risk = risk;
  }

  const invalid = (reason: string): OrderRow => ({ ...row, status: 'invalid', reason });
  if (input.cancelled) return { ...row, status: 'cancelled', reason: 'Dibatalkan' };
  if (!spec) return invalid('Spesifikasi simbol belum dikirim EA MT5');
  if (quote) {
    const ask = quote.ask + offset;
    const bid = quote.bid + offset;
    if (c.side === 'buy' ? ask >= entry : bid <= entry) return invalid('Harga sudah melewati entry');
    const minDist = spec.stopsLevel * spec.point;
    const fromMarket = c.side === 'buy' ? entry - ask : bid - entry;
    if (fromMarket < minDist) return invalid('Entry terlalu dekat harga (stops level)');
    if (Math.abs(entry - sl) < minDist || Math.abs(tp - entry) < minDist) return invalid('SL/TP terlalu dekat entry (stops level)');
  }
  if (row.lot === null || row.lot < spec.volumeMin) return invalid(`Lot di bawah minimum broker (${spec.volumeMin})`);
  return row;
}

// EURUSD -> [EUR, USD], XAUUSD -> [XAU, USD]; broker suffixes are ignored.
export function currenciesOf(symbol: string): string[] {
  const s = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  return s.length >= 6 ? [s.slice(0, 3), s.slice(3, 6)] : [s];
}

export type RiskSummary = {
  orders: number;
  totalRisk: number;
  lowRr: number;
  byCurrency: Record<string, number>;
};

export function summarize(rows: OrderRow[]): RiskSummary {
  const valid = rows.filter((r) => r.status === 'valid');
  const byCurrency: Record<string, number> = {};
  for (const r of valid) {
    for (const cur of currenciesOf(r.symbol)) byCurrency[cur] = roundTo((byCurrency[cur] ?? 0) + (r.risk ?? 0), 2);
  }
  return {
    orders: valid.length,
    totalRisk: roundTo(valid.reduce((a, r) => a + (r.risk ?? 0), 0), 2),
    lowRr: valid.filter((r) => r.lowRr).length,
    byCurrency,
  };
}
