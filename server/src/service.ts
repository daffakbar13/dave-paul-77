import { evaluate, summarize, type OrderRow, type RiskSummary } from './analysis/orders.ts';
import { analyze } from './analysis/sr.ts';
import type { Candle } from './analysis/types.ts';
import { isAffected, type Aggressive } from './news.ts';
import { getSettings, type AccountDoc, type AnalysisDoc, type Collections, type QuoteDoc, type Settings } from './db.ts';

const MINUTE = 60_000;

export async function loadCandles(db: Collections, symbol: string, limit: number): Promise<Candle[]> {
  const docs = await db.candles.find({ symbol }).sort({ t: -1 }).limit(limit).toArray();
  return docs.reverse().map((d) => ({ t: d.t.getTime(), o: d.o, h: d.h, l: d.l, c: d.c }));
}

export function freshQuote(q: QuoteDoc | null, settings: Settings): QuoteDoc | null {
  if (!q) return null;
  return Date.now() - q.at.getTime() <= settings.quoteMaxAgeMinutes * MINUTE ? q : null;
}

// Recomputes one symbol and keeps the cancelled ids when the last candle did not change
// (a settings or quote refresh). A new D1 candle starts a fresh day: cancels reset.
export async function refreshAnalysis(db: Collections, symbol: string, settings: Settings): Promise<AnalysisDoc | null> {
  const sym = await db.symbols.findOne({ name: symbol });
  if (!sym) return null;
  const candles = await loadCandles(db, symbol, settings.sr.lookback);
  if (!candles.length) return null;
  const quote = freshQuote(await db.quotes.findOne({ _id: symbol }), settings);
  const result = analyze(symbol, candles, settings.sr, sym.digits, quote ? (quote.bid + quote.ask) / 2 : undefined);
  const previous = await db.analyses.findOne({ _id: symbol });
  const ids = new Set(result.candidates.map((c) => c.id));
  const cancelled = previous && previous.lastCandleAt.getTime() === result.lastCandleAt
    ? previous.cancelled.filter((id) => ids.has(id))
    : [];
  const doc: AnalysisDoc = {
    _id: symbol,
    analyzedAt: new Date(),
    settingsVersion: settings.version,
    lastCandleAt: new Date(result.lastCandleAt),
    atr: result.atr,
    price: result.price,
    lines: result.lines,
    candidates: result.candidates,
    cancelled,
  };
  await db.analyses.replaceOne({ _id: symbol }, doc, { upsert: true });
  return doc;
}

// Stored analysis, recomputed when settings changed, a newer candle arrived, or it is
// older than 5 minutes (the reference price moves with the quote).
export async function getAnalysis(db: Collections, symbol: string, settings: Settings): Promise<AnalysisDoc | null> {
  const doc = await db.analyses.findOne({ _id: symbol });
  if (doc && doc.settingsVersion === settings.version && Date.now() - doc.analyzedAt.getTime() < 5 * MINUTE) {
    const latest = await db.candles.find({ symbol }, { projection: { t: 1 } }).sort({ t: -1 }).limit(1).next();
    if (latest && latest.t.getTime() === doc.lastCandleAt.getTime()) return doc;
  }
  return refreshAnalysis(db, symbol, settings);
}

export function multiplierFor(account: AccountDoc | null, symbol: string, aggressive: Aggressive): number {
  if (!account || aggressive.mode === 'off') return 1;
  if (aggressive.mode === 'on') return account.aggressiveMultiplier;
  return account.aggressiveAuto && isAffected(symbol, aggressive.affected) ? account.aggressiveMultiplier : 1;
}

export function rowsFor(
  analysis: AnalysisDoc,
  account: AccountDoc | null,
  quote: QuoteDoc | null,
  settings: Settings,
  aggressive: Aggressive,
): OrderRow[] {
  const symbol = analysis._id;
  const cancelled = new Set(analysis.cancelled);
  return analysis.candidates.map((candidate) =>
    evaluate({
      symbol,
      candidate,
      cancelled: cancelled.has(candidate.id),
      spec: account?.specs[symbol],
      quote: quote ?? undefined,
      balance: account?.balance ?? 0,
      riskPct: account?.riskPct ?? 0,
      multiplier: multiplierFor(account, symbol, aggressive),
      rrThreshold: settings.rrThreshold,
      offset: account?.offsets[symbol] ?? 0,
    }),
  );
}

export type AccountOrders = {
  account: { id: string; name: string; number: number; balance: number | null; currency: string | null; balanceAt: Date | null; stale: boolean; multiplier: number; aggressiveAuto: boolean };
  rows: OrderRow[];
  summary: RiskSummary;
};

export function accountInfo(account: AccountDoc, settings: Settings): AccountOrders['account'] {
  const stale = !account.balanceAt || Date.now() - account.balanceAt.getTime() > settings.balanceStaleMinutes * MINUTE;
  return {
    id: account._id.toHexString(),
    name: account.name,
    number: account.number,
    balance: account.balance,
    currency: account.currency,
    balanceAt: account.balanceAt,
    stale,
    multiplier: account.aggressiveMultiplier,
    aggressiveAuto: account.aggressiveAuto,
  };
}

// All active symbols for one account: the Pending Orders table and the Execute modal.
export async function ordersForAccount(db: Collections, account: AccountDoc, aggressive: Aggressive): Promise<AccountOrders> {
  const settings = await getSettings(db);
  const symbols = await db.symbols.find({ active: true }).sort({ order: 1 }).toArray();
  const rows: OrderRow[] = [];
  for (const s of symbols) {
    const analysis = await getAnalysis(db, s.name, settings);
    if (!analysis) continue;
    const quote = freshQuote(await db.quotes.findOne({ _id: s.name }), settings);
    rows.push(...rowsFor(analysis, account, quote, settings, aggressive));
  }
  return { account: accountInfo(account, settings), rows, summary: summarize(rows) };
}
