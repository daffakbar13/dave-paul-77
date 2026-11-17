// TF signals: the buy and sell stops of the current analysis, to copy by hand into the
// Traders Family mobile app, and the "created" marks the analyst ticks off per day.
import type { Side } from './analysis/types.ts';
import { roundTo } from './analysis/sr.ts';
import { getSettings, type AccountDoc, type Collections } from './db.ts';
import { NO_AGGRESSIVE } from './news.ts';
import { freshQuote, getAnalysis, rowsFor } from './service.ts';

export type TfOrder = {
  id: string; // level id
  symbol: string; // app symbol
  side: Side;
  type: 'buy stop' | 'sell stop';
  entry: number;
  sl: number;
  tp: number;
};

// Every level of the active pairs that is still a pending stop on the right side of price,
// in the account's MT5 prices. Not the EA's orders: a level whose MT5 position is running
// (filled on a day no signal was posted) is not running in TF, and MT5-only checks (lot,
// symbol spec) do not apply to TF. Skipped and cancelled levels stay out.
export async function tfOrders(db: Collections, account: AccountDoc): Promise<{ rows: TfOrder[]; analyzedAt: Date | null }> {
  const settings = await getSettings(db);
  const symbols = await db.symbols.find({ active: true }).toArray();
  const rows: TfOrder[] = [];
  let analyzedAt: Date | null = null;
  for (const s of symbols) {
    const analysis = await getAnalysis(db, s.name, settings);
    if (!analysis) continue;
    if (!analyzedAt || analysis.analyzedAt < analyzedAt) analyzedAt = analysis.analyzedAt;
    const quote = freshQuote(await db.quotes.findOne({ _id: s.name }), settings);
    const offset = account.offsets?.[s.name] ?? 0;
    const digits = account.specs?.[s.name]?.digits ?? s.digits;
    // no fresh quote: the price the analysis split the lines at
    const ask = roundTo((quote?.ask ?? analysis.price) + offset, digits);
    const bid = roundTo((quote?.bid ?? analysis.price) + offset, digits);
    for (const r of rowsFor(analysis, account, quote, settings, NO_AGGRESSIVE)) {
      if (r.status === 'skipped' || r.status === 'cancelled' || r.entry === null || r.sl === null || r.tp === null) continue;
      if (r.side === 'buy' ? r.entry <= ask : r.entry >= bid) continue; // price is already past the entry
      rows.push({ id: r.id, symbol: r.symbol, side: r.side, type: r.type, entry: r.entry, sl: r.sl, tp: r.tp });
    }
  }
  return { rows, analyzedAt };
}

// Marks reset every day at 05:00 WIB (22:00 UTC): the mark day is the UTC date two hours
// ahead, so 21:59 UTC still counts for today and 22:00 UTC starts the next day.
const RESET_SHIFT = 2 * 3_600_000;
export function markDay(now: Date = new Date()): string {
  return new Date(now.getTime() + RESET_SHIFT).toISOString().slice(0, 10);
}
