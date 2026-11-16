// TF signals: the orders the EA actually holds for one account, to copy by hand into the
// Traders Family mobile app, and the "created" marks the analyst ticks off per day.
import type { AccountDoc, Collections } from './db.ts';
import type { Side } from './analysis/types.ts';
import { tr } from './i18n.ts';

export type SentOrder = {
  id: string; // level id, or `pos:<ticket>` for a position without a plan
  symbol: string; // app symbol
  side: Side;
  type: 'buy stop' | 'sell stop';
  entry: number;
  sl: number;
  tp: number;
  status: 'valid' | 'running'; // valid: pending order on the broker; running: filled, still open
  reason?: string;
  ticket: number;
};

// Pending orders come from the journal: a trade stays 'placed' until a deal fills it or a
// later Execute deletes it ('cancelled'). Open positions come from the EA's last status,
// so a fill whose deals are not reported yet already counts as running. An order deleted
// by hand in MT5 is not reported by the EA and stays listed until the next Execute.
export async function sentOrders(db: Collections, account: AccountDoc): Promise<{ rows: SentOrder[]; sentAt: Date | null }> {
  const positions = account.positions ?? [];
  const open = new Map(positions.map((p) => [p.ticket, p]));
  const trades = await db.trades
    .find({ accountId: account._id, $or: [{ status: 'placed' }, { ticket: { $in: [...open.keys()] } }] })
    .toArray();
  const byTicket = new Map(trades.map((t) => [t.ticket, t]));
  const rows: SentOrder[] = [];

  for (const t of trades) {
    if (t.status !== 'placed' || open.has(t.ticket) || !t.plan) continue;
    rows.push({
      id: t.ref ?? `pos:${t.ticket}`, symbol: t.symbol, side: t.side, type: `${t.side} stop`,
      entry: t.plan.entry, sl: t.plan.sl, tp: t.plan.tp, status: 'valid', ticket: t.ticket,
    });
  }
  for (const p of positions) {
    const plan = byTicket.get(p.ticket)?.plan;
    const sl = plan?.sl ?? p.sl;
    const tp = plan?.tp ?? p.tp;
    if (!sl || !tp) continue; // no stop or target on the broker: nothing TF would accept
    rows.push({
      id: byTicket.get(p.ticket)?.ref ?? `pos:${p.ticket}`, symbol: p.symbol, side: p.side, type: `${p.side} stop`,
      entry: plan?.entry ?? p.openPrice, sl, tp, status: 'running', ticket: p.ticket,
      reason: tr(`Posisi berjalan #${p.ticket}: ${p.volume} lot @ ${p.openPrice}`, `Open position #${p.ticket}: ${p.volume} lot @ ${p.openPrice}`),
    });
  }

  const last = await db.commands.findOne(
    { accountId: account._id, status: { $in: ['done', 'failed'] }, dryRun: { $ne: true } },
    { sort: { createdAt: -1 }, projection: { finishedAt: 1, createdAt: 1 } },
  );
  return { rows, sentAt: last ? (last.finishedAt ?? last.createdAt) : null };
}

// Marks reset every day at 05:00 WIB (22:00 UTC): the mark day is the UTC date two hours
// ahead, so 21:59 UTC still counts for today and 22:00 UTC starts the next day.
const RESET_SHIFT = 2 * 3_600_000;
export function markDay(now: Date = new Date()): string {
  return new Date(now.getTime() + RESET_SHIFT).toISOString().slice(0, 10);
}
