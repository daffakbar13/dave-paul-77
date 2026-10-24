// Statistics, monthly table, equity curve and CSV for a backtest. Pure functions over the
// trades the replay engine produced; the definitions follow the summary screens the user
// works with (Overall / Per Month / Growth).
import { roundTo } from './sr.ts';
import type { Side } from './types.ts';

export const DAY = 86_400_000;

// One simulated trade. Times are the UTC start of the D1 candle; entry/tp/sl are the
// planned levels. pips use the 4-digit convention (pipSize), r is the result in risk units.
export type BtTrade = {
  symbol: string;
  side: Side;
  entryAt: number;
  exitAt: number | null; // null while still open on the last candle
  entry: number;
  tp: number;
  sl: number;
  result: 'TP' | 'SL' | 'Open';
  tpPips: number; // distance entry -> TP
  slPips: number; // distance entry -> SL
  pips: number; // realised, signed; 0 while open
  r: number; // realised, signed; 0 while open
  riskMoney: number; // balance at the fill day x risk %
  profit: number; // realised, signed
  balanceBefore: number;
  ambiguous: boolean; // the D1 candle could not show whether SL or TP came first; SL was taken
  digits: number;
};

export type Streak = { count: number; pips: number };

export type Overall = {
  trades: number;
  wins: number;
  losses: number;
  probability: number | null; // 0..1
  profit: number;
  profitPct: number; // of the starting balance
  avgProfitTrade: number;
  avgProfitTradePct: number;
  avgProfitMonth: number;
  avgProfitMonthPct: number;
  avgProfitYear: number;
  avgProfitYearPct: number;
  pips: number;
  avgPipsTrade: number;
  avgPipsMonth: number;
  avgPipsYear: number;
  months: number; // calendar months from the first to the last exit
  years: number; // calendar years touched
  riskReward: number | null; // total SL distance / total TP distance, in pips
  avgHoldDays: number | null;
  profitFactor: number | null; // gross profit pips / gross loss pips
  expectancyR: number | null;
  maxDrawdown: number; // money, from the equity curve
  maxDrawdownPct: number;
  consecutiveProfit: { byTrade: Streak; byPips: Streak };
  consecutiveLoss: { byTrade: Streak; byPips: Streak };
  ambiguous: number; // trades whose result flips if the D1 candle was traversed the other way
  open: number;
  peakOpen: number; // most trades open on one day (each risks the same %)
};

export type MonthRow = { year: number; months: (number | null)[]; ytd: number };
export type MonthTable = { rows: MonthRow[]; total: number };

export type CurvePoint = { t: number; balance: number };

const r1 = (v: number) => roundTo(v, 1);
const r2 = (v: number) => roundTo(v, 2);
const zero: Streak = { count: 0, pips: 0 };

// Closed trades in the order they closed (ties: the one opened first).
export function closedInOrder(trades: BtTrade[]): BtTrade[] {
  return trades.filter((t) => t.result !== 'Open').sort((a, b) => a.exitAt! - b.exitAt! || a.entryAt - b.entryAt);
}

// Longest run of same-sign trades by count (ties: more pips) and the run with the most
// pips (ties: more trades). `sign` +1 scans wins, -1 scans losses.
export function streaks(ordered: BtTrade[], sign: 1 | -1): { byTrade: Streak; byPips: Streak } {
  let byTrade = zero;
  let byPips = zero;
  let cur: Streak = { count: 0, pips: 0 };
  const better = (a: Streak, b: Streak) => (sign === 1 ? a.pips > b.pips : a.pips < b.pips);
  for (const t of ordered) {
    if (Math.sign(t.pips) === sign) cur = { count: cur.count + 1, pips: cur.pips + t.pips };
    else cur = zero;
    if (cur.count > byTrade.count || (cur.count === byTrade.count && better(cur, byTrade))) byTrade = cur;
    if (better(cur, byPips) || (cur.pips === byPips.pips && cur.count > byPips.count)) byPips = cur;
  }
  const fix = (s: Streak): Streak => ({ count: s.count, pips: r2(s.pips) });
  return { byTrade: fix(byTrade), byPips: fix(byPips) };
}

const monthKey = (t: number) => {
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

// Equity after every closing day, starting at the first fill.
export function equityCurve(trades: BtTrade[], initial: number): CurvePoint[] {
  const closed = closedInOrder(trades);
  if (!closed.length) return [];
  const first = Math.min(...closed.map((t) => t.entryAt));
  const points: CurvePoint[] = [{ t: first, balance: initial }];
  let balance = initial;
  for (let i = 0; i < closed.length; i++) {
    balance += closed[i]!.profit;
    const next = closed[i + 1];
    if (!next || next.exitAt !== closed[i]!.exitAt) points.push({ t: closed[i]!.exitAt!, balance: r2(balance) });
  }
  return points;
}

export function drawdown(curve: CurvePoint[]): { amount: number; pct: number } {
  let peak = -Infinity;
  let amount = 0;
  let pct = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.balance);
    amount = Math.max(amount, peak - p.balance);
    if (peak > 0) pct = Math.max(pct, (peak - p.balance) / peak);
  }
  return { amount: r2(amount), pct: r2(pct * 100) };
}

// At most `max` points for the chart; the first and last are always kept.
export function thin(curve: CurvePoint[], max: number): CurvePoint[] {
  if (curve.length <= max) return curve;
  const step = (curve.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => curve[Math.round(i * step)]!);
}

// Most trades open at once, counting the fill and exit days as open.
export function peakOpen(trades: BtTrade[]): number {
  const events: [number, number][] = [];
  for (const t of trades) {
    events.push([t.entryAt, 1]);
    if (t.exitAt !== null) events.push([t.exitAt + DAY, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  for (const [, d] of events) {
    now += d;
    peak = Math.max(peak, now);
  }
  return peak;
}

export function overall(trades: BtTrade[], initial: number): Overall {
  const closed = closedInOrder(trades);
  const wins = closed.filter((t) => t.result === 'TP');
  const losses = closed.filter((t) => t.result === 'SL');
  const profit = closed.reduce((s, t) => s + t.profit, 0);
  const pips = closed.reduce((s, t) => s + t.pips, 0);
  const n = closed.length;
  const first = closed[0] ? monthKey(Math.min(...closed.map((t) => t.exitAt!))) : 0;
  const last = closed.length ? monthKey(closed[closed.length - 1]!.exitAt!) : 0;
  const months = n ? last - first + 1 : 0;
  const years = n ? Math.floor(last / 12) - Math.floor(first / 12) + 1 : 0;
  const per = (v: number, d: number) => (d > 0 ? v / d : 0);
  const pct = (v: number) => (initial > 0 ? r2((v / initial) * 100) : 0);
  const sumTp = closed.reduce((s, t) => s + t.tpPips, 0);
  const sumSl = closed.reduce((s, t) => s + t.slPips, 0);
  const grossWin = wins.reduce((s, t) => s + t.pips, 0);
  const grossLoss = losses.reduce((s, t) => s - t.pips, 0);
  const dd = drawdown(equityCurve(trades, initial));
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    probability: n ? wins.length / n : null,
    profit: r2(profit),
    profitPct: pct(profit),
    avgProfitTrade: r2(per(profit, n)),
    avgProfitTradePct: pct(per(profit, n)),
    avgProfitMonth: r2(per(profit, months)),
    avgProfitMonthPct: pct(per(profit, months)),
    avgProfitYear: r2(per(profit, years)),
    avgProfitYearPct: pct(per(profit, years)),
    pips: r1(pips),
    avgPipsTrade: r1(per(pips, n)),
    avgPipsMonth: r1(per(pips, months)),
    avgPipsYear: r1(per(pips, years)),
    months,
    years,
    riskReward: sumTp > 0 ? roundTo(sumSl / sumTp, 2) : null,
    avgHoldDays: n ? roundTo(closed.reduce((s, t) => s + (t.exitAt! - t.entryAt) / DAY, 0) / n, 2) : null,
    profitFactor: grossLoss > 0 ? roundTo(grossWin / grossLoss, 2) : null,
    expectancyR: n ? roundTo(closed.reduce((s, t) => s + t.r, 0) / n, 3) : null,
    maxDrawdown: dd.amount,
    maxDrawdownPct: dd.pct,
    consecutiveProfit: streaks(closed, 1),
    consecutiveLoss: streaks(closed, -1),
    ambiguous: closed.filter((t) => t.ambiguous).length,
    open: trades.length - n,
    peakOpen: peakOpen(trades),
  };
}

// Sum per exit month. `pick` chooses pips or money.
export function monthTable(trades: BtTrade[], pick: (t: BtTrade) => number): MonthTable {
  const byYear = new Map<number, (number | null)[]>();
  for (const t of closedInOrder(trades)) {
    const d = new Date(t.exitAt!);
    const row = byYear.get(d.getUTCFullYear()) ?? Array<number | null>(12).fill(null);
    row[d.getUTCMonth()] = (row[d.getUTCMonth()] ?? 0) + pick(t);
    byYear.set(d.getUTCFullYear(), row);
  }
  const rows = [...byYear]
    .sort((a, b) => a[0] - b[0])
    .map(([year, months]) => ({ year, months: months.map((m) => (m === null ? null : r1(m))), ytd: r1(months.reduce<number>((s, m) => s + (m ?? 0), 0)) }));
  return { rows, total: r1(rows.reduce((s, r) => s + r.ytd, 0)) };
}

// --- per pair ------------------------------------------------------------------

export type PairGrade = 'good' | 'ok' | 'weak' | 'few';

export type PairStats = {
  symbol: string;
  trades: number;
  winRate: number | null;
  pips: number;
  profit: number;
  profitFactor: number | null;
  expectancyR: number | null;
  riskReward: number | null;
  maxLossStreak: number;
  maxDrawdownR: number; // largest drop of the cumulative R, positive
  perYear: number | null; // trades per year
  ambiguousShare: number | null; // share of trades the D1 candle could not order
  grade: PairGrade;
};

export const MIN_PAIR_TRADES = 30;

export function gradeOf(trades: number, expectancyR: number | null, profitFactor: number | null): PairGrade {
  if (trades < MIN_PAIR_TRADES || expectancyR === null) return 'few';
  if (expectancyR >= 0.15 && (profitFactor ?? Infinity) >= 1.3) return 'good';
  if (expectancyR > 0 && (profitFactor ?? Infinity) > 1) return 'ok';
  return 'weak';
}

export function pairStats(symbol: string, trades: BtTrade[], initial: number): PairStats {
  const o = overall(trades, initial);
  const closed = closedInOrder(trades);
  let cum = 0;
  let peak = 0;
  let ddR = 0;
  for (const t of closed) {
    cum += t.r;
    peak = Math.max(peak, cum);
    ddR = Math.max(ddR, peak - cum);
  }
  const years = closed.length ? Math.max((closed[closed.length - 1]!.exitAt! - Math.min(...closed.map((t) => t.entryAt))) / (365.25 * DAY), 1 / 12) : 0;
  return {
    symbol,
    trades: o.trades,
    winRate: o.probability,
    pips: o.pips,
    profit: o.profit,
    profitFactor: o.profitFactor,
    expectancyR: o.expectancyR,
    riskReward: o.riskReward,
    maxLossStreak: o.consecutiveLoss.byTrade.count,
    maxDrawdownR: roundTo(ddR, 2),
    perYear: years > 0 ? roundTo(o.trades / years, 1) : null,
    ambiguousShare: o.trades ? roundTo(o.ambiguous / o.trades, 3) : null,
    grade: gradeOf(o.trades, o.expectancyR, o.profitFactor),
  };
}

// --- CSV -------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 02-Jan-2024
export function csvDate(t: number): string {
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

// up to 6 decimals, trailing zeros dropped (1.094, 1.09303)
export function csvPrice(v: number): string {
  return String(roundTo(v, 6));
}

const SEP = ';';
const cell = (v: string | number) => String(v).replace(/[;\r\n]/g, ' ');

export const CSV_HEAD = ['Pair', 'Action', 'Tanggal Entry', 'Tanggal Exit', 'Entry', 'TP', 'SL', 'Keterangan'];
export const CSV_DETAIL_HEAD = [...CSV_HEAD, 'Pips', 'R', 'Risiko', 'Profit', 'Balance Awal Hari', 'Ambigu'];

// Trades ordered by entry day, then pair. `detail` adds the money columns.
export function tradesCsv(trades: BtTrade[], detail = false): string {
  const sorted = [...trades].sort((a, b) => a.entryAt - b.entryAt || a.symbol.localeCompare(b.symbol) || a.entry - b.entry);
  const lines = [(detail ? CSV_DETAIL_HEAD : CSV_HEAD).join(SEP)];
  for (const t of sorted) {
    const base = [
      t.symbol,
      t.side === 'buy' ? 'Buy' : 'Sell',
      csvDate(t.entryAt),
      t.exitAt === null ? '' : csvDate(t.exitAt),
      csvPrice(t.entry),
      csvPrice(t.tp),
      csvPrice(t.sl),
      t.result,
    ];
    if (detail) {
      const closed = t.result !== 'Open';
      base.push(
        closed ? String(r1(t.pips)) : '',
        closed ? String(roundTo(t.r, 2)) : '',
        String(r2(t.riskMoney)),
        closed ? String(r2(t.profit)) : '',
        String(r2(t.balanceBefore)),
        t.ambiguous ? 'ya' : '',
      );
    }
    lines.push(base.map(cell).join(SEP));
  }
  return `${lines.join('\r\n')}\r\n`;
}
