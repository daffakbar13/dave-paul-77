// Trade journal: MT5 deals folded into one trade per position, and the monthly audit
// over closed trades. Pure functions; storage is in ../journal.ts.
import { roundTo } from './sr.ts';
import type { Side } from './types.ts';

export type DealEntry = 'in' | 'out' | 'inout' | 'out_by';
export type CloseReason = 'sl' | 'tp' | 'so' | 'expert' | 'manual';

export type Deal = {
  ticket: number;
  order: number;
  time: Date; // UTC
  side: Side; // deal direction: the exit of a buy is a sell deal
  entry: DealEntry;
  reason: CloseReason;
  volume: number;
  price: number;
  sl: number;
  tp: number;
  profit: number;
  commission: number;
  swap: number;
  fee: number;
  comment: string;
};

// What the app planned when the order was sent, kept with the trade because commands
// are purged after 30 days.
export type TradePlan = {
  commandId: string;
  placedAt: Date;
  aggressive: 'auto' | 'on' | 'off';
  line: number;
  lineSource: 'manual' | 'auto';
  entry: number;
  sl: number;
  tp: number;
  tpAuto: boolean;
  slFrom?: 'candle' | 'ladder';
  lot: number;
  risk: number | null; // account currency
  rr: number | null;
  multiplier: number;
  atr: number | null;
  newsAffected: boolean;
};

// placed: pending order on the broker; cancelled: deleted by a later command before a fill
export type TradeStatus = 'placed' | 'cancelled' | 'open' | 'closed';

export type TradeState = {
  status: TradeStatus;
  openedAt: Date | null;
  openPrice: number | null;
  volume: number;
  closedAt: Date | null;
  closePrice: number | null;
  closeReason: CloseReason | null;
  profit: number;
  costs: number; // commission + swap + fee (negative is a cost)
  net: number;
};

const EPS = 1e-9;

function vwap(deals: Deal[]): number | null {
  const v = deals.reduce((s, d) => s + d.volume, 0);
  return v > 0 ? roundTo(deals.reduce((s, d) => s + d.price * d.volume, 0) / v, 6) : null;
}

// Folds every deal of one position. Without an entry deal the previous status stays
// (a placed or cancelled order).
export function foldDeals(deals: Deal[], previous: TradeStatus): TradeState {
  const sorted = [...deals].sort((a, b) => a.time.getTime() - b.time.getTime() || a.ticket - b.ticket);
  const ins = sorted.filter((d) => d.entry === 'in' || d.entry === 'inout');
  const outs = sorted.filter((d) => d.entry === 'out' || d.entry === 'out_by');
  const volume = roundTo(ins.reduce((s, d) => s + d.volume, 0), 2);
  const closedVolume = outs.reduce((s, d) => s + d.volume, 0);
  const profit = roundTo(sorted.reduce((s, d) => s + d.profit, 0), 2);
  const costs = roundTo(sorted.reduce((s, d) => s + d.commission + d.swap + d.fee, 0), 2);
  const closed = volume > 0 && closedVolume >= volume - EPS;
  const last = outs.at(-1);
  return {
    status: volume > 0 ? (closed ? 'closed' : 'open') : previous,
    openedAt: ins[0]?.time ?? null,
    openPrice: vwap(ins),
    volume,
    closedAt: closed ? last!.time : null,
    closePrice: closed ? vwap(outs) : null,
    closeReason: closed ? last!.reason : null,
    profit,
    costs,
    net: roundTo(profit + costs, 2),
  };
}

// --- audit -------------------------------------------------------------------

export type AuditTrade = {
  symbol: string;
  side: Side;
  openedAt: Date;
  closedAt: Date;
  openPrice: number;
  closeReason: CloseReason;
  net: number;
  plan: TradePlan | null;
};

export type Stats = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null; // 0..1
  net: number;
  grossProfit: number;
  grossLoss: number; // negative
  profitFactor: number | null; // null when there is no loss
  avgWin: number | null;
  avgLoss: number | null;
  avgR: number | null; // over trades with a planned risk
  totalR: number | null;
};

export type Group = Stats & { key: string };

export type Finding = { level: 'warn' | 'info' | 'good'; text: string };

export type Audit = {
  stats: Stats;
  maxDrawdown: number; // largest drop of the cumulative net, positive money
  avgHoldHours: number | null;
  avgSlipR: number | null; // fill worse than the planned entry, in R; positive = worse
  bySymbol: Group[];
  bySide: Group[];
  byReason: Group[];
  bySlFrom: Group[];
  byMode: Group[]; // normal vs Aggressive
  byLineSource: Group[];
  byRr: Group[];
  // distinct levels (ref) placed in the period: Execute every day places the same level again
  fills: { placed: number; filled: number; cancelled: number; rate: number | null };
  unplanned: number; // positions of the app's magic with no recorded plan
  findings: Finding[];
};

export function rOf(t: AuditTrade): number | null {
  return t.plan?.risk && t.plan.risk > 0 ? t.net / t.plan.risk : null;
}

// Fill price against the planned entry as a share of the planned risk distance.
export function slipR(t: AuditTrade): number | null {
  if (!t.plan) return null;
  const dist = Math.abs(t.plan.entry - t.plan.sl);
  if (!(dist > 0)) return null;
  return ((t.openPrice - t.plan.entry) * (t.side === 'buy' ? 1 : -1)) / dist;
}

const r2 = (v: number) => roundTo(v, 2);
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export function stats(trades: AuditTrade[]): Stats {
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net < 0);
  const grossProfit = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = losses.reduce((s, t) => s + t.net, 0);
  const rs = trades.map(rOf).filter((r): r is number => r !== null);
  const avgWin = avg(wins.map((t) => t.net));
  const avgLoss = avg(losses.map((t) => t.net));
  const avgR = avg(rs);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    net: r2(grossProfit + grossLoss),
    grossProfit: r2(grossProfit),
    grossLoss: r2(grossLoss),
    profitFactor: grossLoss < 0 ? r2(grossProfit / -grossLoss) : null,
    avgWin: avgWin === null ? null : r2(avgWin),
    avgLoss: avgLoss === null ? null : r2(avgLoss),
    avgR: avgR === null ? null : r2(avgR),
    totalR: rs.length ? r2(rs.reduce((s, r) => s + r, 0)) : null,
  };
}

function groupBy(trades: AuditTrade[], key: (t: AuditTrade) => string | null): Group[] {
  const map = new Map<string, AuditTrade[]>();
  for (const t of trades) {
    const k = key(t);
    if (k === null) continue;
    map.set(k, [...(map.get(k) ?? []), t]);
  }
  return [...map].map(([k, ts]) => ({ key: k, ...stats(ts) })).sort((a, b) => a.net - b.net);
}

export function rrBucket(rr: number | null | undefined): string | null {
  if (rr === null || rr === undefined) return null;
  return rr < 1.5 ? 'RR < 1.5' : rr < 2.5 ? 'RR 1.5-2.5' : 'RR ≥ 2.5';
}

export function maxDrawdown(trades: AuditTrade[]): number {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const t of [...trades].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime())) {
    equity += t.net;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return r2(dd);
}

const REASON_LABEL: Record<CloseReason, string> = { sl: 'SL', tp: 'TP', so: 'Stop out', expert: 'EA', manual: 'Manual' };
const fmtR = (r: number) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const MIN_GROUP = 3; // fewer trades in a group say nothing

// Rule-based notes for the monthly review. They point at what to look at; one month is
// rarely enough to change a parameter.
export function findings(a: Omit<Audit, 'findings'>): Finding[] {
  const out: Finding[] = [];
  const s = a.stats;
  if (!s.trades) return [{ level: 'info', text: 'Belum ada trade yang close di periode ini.' }];

  if (s.trades < 20)
    out.push({ level: 'info', text: `Sampel kecil (${s.trades} trade). Pakai sebagai catatan; ubah parameter hanya jika pola yang sama muncul lagi bulan depan.` });

  if (s.profitFactor !== null && s.profitFactor < 1)
    out.push({ level: 'warn', text: `Profit factor ${s.profitFactor} (< 1): total rugi lebih besar dari total untung.` });
  else if (s.profitFactor !== null && s.profitFactor >= 1.5) out.push({ level: 'good', text: `Profit factor ${s.profitFactor}.` });

  if (s.winRate !== null && s.avgWin !== null && s.avgLoss !== null) {
    const breakEven = -s.avgLoss / (s.avgWin - s.avgLoss);
    if (s.winRate < breakEven)
      out.push({ level: 'warn', text: `Win rate ${pct(s.winRate)} di bawah titik impas ${pct(breakEven)} untuk rata-rata untung/rugi sekarang: perbesar TP (RR) atau saring level yang lemah.` });
  }

  for (const g of a.bySymbol) {
    if (g.trades >= MIN_GROUP && g.net < 0 && (g.avgR ?? -1) < -0.3)
      out.push({ level: 'warn', text: `${g.key}: ${g.trades} trade, net ${g.net}${g.avgR !== null ? `, rata-rata ${fmtR(g.avgR)}` : ''}. Cek garis S/R dan Min SL pair ini.` });
  }

  const sl = a.byReason.find((g) => g.key === REASON_LABEL.sl);
  const tp = a.byReason.find((g) => g.key === REASON_LABEL.tp);
  if (sl && sl.trades / s.trades >= 0.6)
    out.push({ level: 'warn', text: `${pct(sl.trades / s.trades)} trade close di SL${tp ? ` (TP ${tp.trades})` : ''}: SL mungkin terlalu dekat atau entry terlalu dekat garis.` });
  const so = a.byReason.find((g) => g.key === REASON_LABEL.so);
  if (so) out.push({ level: 'warn', text: `${so.trades} posisi kena stop out: risiko total terlalu besar untuk balance.` });
  const manual = a.byReason.find((g) => g.key === REASON_LABEL.manual);
  if (manual && manual.trades >= 2)
    out.push({ level: manual.net < 0 ? 'warn' : 'info', text: `${manual.trades} posisi ditutup manual, net ${manual.net}. Bandingkan dengan hasil jika dibiarkan ke SL/TP.` });

  if (a.avgSlipR !== null && a.avgSlipR > 0.1)
    out.push({ level: 'warn', text: `Fill rata-rata ${fmtR(a.avgSlipR)} lebih buruk dari entry rencana (spread/berita): risiko nyata lebih besar dari rencana.` });

  const candle = a.bySlFrom.find((g) => g.key === 'candle');
  const ladder = a.bySlFrom.find((g) => g.key === 'ladder');
  if (candle && ladder && candle.trades >= MIN_GROUP && ladder.trades >= MIN_GROUP && candle.avgR !== null && ladder.avgR !== null) {
    const better = candle.avgR > ladder.avgR ? 'candle' : 'ladder';
    out.push({ level: 'info', text: `SL dari ${better} lebih baik: candle ${fmtR(candle.avgR)} (${candle.trades}) vs ladder ${fmtR(ladder.avgR)} (${ladder.trades}).` });
  }

  const aggr = a.byMode.find((g) => g.key === 'Aggressive');
  if (aggr && aggr.trades >= 2 && aggr.net < 0)
    out.push({ level: 'warn', text: `Aggressive: ${aggr.trades} trade, net ${aggr.net}. Lot yang diperbesar merugi; pertimbangkan multiplier lebih kecil atau Aggressive auto mati.` });
  else if (aggr && aggr.trades >= 2 && aggr.net > 0) out.push({ level: 'good', text: `Aggressive: ${aggr.trades} trade, net +${aggr.net}.` });

  const lowRr = a.byRr.find((g) => g.key === 'RR < 1.5');
  if (lowRr && lowRr.trades >= MIN_GROUP && lowRr.net < 0)
    out.push({ level: 'warn', text: `Level RR < 1.5: ${lowRr.trades} trade, net ${lowRr.net}. Pertimbangkan tidak mengeksekusi level bertanda kuning.` });

  if (a.fills.placed >= 10 && a.fills.rate !== null)
    out.push({ level: 'info', text: `${a.fills.filled} dari ${a.fills.placed} level yang dipasang ter-fill (${pct(a.fills.rate)}).` });
  if (a.unplanned) out.push({ level: 'info', text: `${a.unplanned} posisi tanpa rencana tercatat (dipasang sebelum jurnal aktif): tidak ikut hitungan R.` });

  return out;
}

export function audit(trades: AuditTrade[], fills: Audit['fills'], unplanned: number): Audit {
  const hold = avg(trades.map((t) => (t.closedAt.getTime() - t.openedAt.getTime()) / 3_600_000));
  const slips = trades.map(slipR).filter((v): v is number => v !== null);
  const slip = avg(slips);
  const base = {
    stats: stats(trades),
    maxDrawdown: maxDrawdown(trades),
    avgHoldHours: hold === null ? null : roundTo(hold, 1),
    avgSlipR: slip === null ? null : roundTo(slip, 3),
    bySymbol: groupBy(trades, (t) => t.symbol),
    bySide: groupBy(trades, (t) => (t.side === 'buy' ? 'Buy' : 'Sell')),
    byReason: groupBy(trades, (t) => REASON_LABEL[t.closeReason]),
    bySlFrom: groupBy(trades, (t) => t.plan?.slFrom ?? null),
    byMode: groupBy(trades, (t) => (t.plan ? (t.plan.multiplier > 1 ? 'Aggressive' : 'Normal') : null)),
    byLineSource: groupBy(trades, (t) => (t.plan ? (t.plan.lineSource === 'manual' ? 'Garis manual' : 'Garis otomatis') : null)),
    byRr: groupBy(trades, (t) => rrBucket(t.plan?.rr)),
    fills,
    unplanned,
  };
  return { ...base, findings: findings(base) };
}
