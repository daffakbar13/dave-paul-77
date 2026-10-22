// Trade journal storage: placements from command results, deals from the MT5 EA, and
// the monthly audit read.
import { ObjectId } from 'mongodb';
import { audit, foldDeals, type Audit, type AuditTrade, type Deal, type TradePlan } from './analysis/journal.ts';
import type { AccountDoc, CommandDoc, Collections, TradeDoc } from './db.ts';

const appSymbol = (ref: string) => ref.split(':')[0]!;

function planOf(command: CommandDoc, ref: string): TradePlan | null {
  const p = command.plans?.find((x) => x.ref === ref);
  if (!p) return null;
  const { ref: _ref, ...rest } = p;
  return { ...rest, commandId: command._id.toHexString(), placedAt: command.finishedAt ?? command.createdAt };
}

// A live command result: every placed order becomes a trade document. The EA deleted the
// app's earlier pending orders first, so those that never filled are cancelled (a deal
// that arrives later still turns them into a position).
export async function recordPlacements(db: Collections, command: CommandDoc): Promise<number> {
  if (command.dryRun) return 0;
  const now = new Date();
  await db.trades.updateMany(
    { accountId: command.accountId, status: 'placed', 'plan.commandId': { $ne: command._id.toHexString() } },
    { $set: { status: 'cancelled', updatedAt: now } },
  );
  const placed = (command.results ?? []).filter((r) => r.ok && r.ticket);
  for (const r of placed) {
    const order = command.orders.find((o) => o.ref === r.ref);
    if (!order) continue;
    await db.trades.updateOne(
      { accountId: command.accountId, ticket: r.ticket! },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          accountNumber: command.accountNumber,
          ref: r.ref,
          symbol: appSymbol(r.ref),
          side: order.side,
          deals: [],
          status: 'placed',
          openedAt: null,
          openPrice: null,
          volume: 0,
          closedAt: null,
          closePrice: null,
          closeReason: null,
          profit: 0,
          costs: 0,
          net: 0,
          createdAt: now,
        },
        $set: { plan: planOf(command, r.ref), updatedAt: now },
      },
      { upsert: true },
    );
  }
  return placed.length;
}

export type IncomingDeal = Deal & { position: number; symbol: string }; // app symbol

// Deals grouped by position and merged into the trade by deal ticket, so a resend
// changes nothing. A position without a placement (placed before the journal, or the
// result never arrived) gets its plan from a command that still has its ticket.
export async function recordDeals(db: Collections, account: AccountDoc, deals: IncomingDeal[]): Promise<{ deals: number; trades: number }> {
  const byPosition = new Map<number, IncomingDeal[]>();
  for (const d of deals) byPosition.set(d.position, [...(byPosition.get(d.position) ?? []), d]);
  const now = new Date();
  for (const [position, incoming] of byPosition) {
    const existing = await db.trades.findOne({ accountId: account._id, ticket: position });
    const merged = new Map<number, Deal>((existing?.deals ?? []).map((d) => [d.ticket, d]));
    for (const { position: _p, symbol: _s, ...d } of incoming) merged.set(d.ticket, d);
    const list = [...merged.values()].sort((a, b) => a.time.getTime() - b.time.getTime() || a.ticket - b.ticket);
    const state = foldDeals(list, existing?.status ?? 'placed');
    if (existing) {
      await db.trades.updateOne({ _id: existing._id }, { $set: { ...state, deals: list, updatedAt: now } });
      continue;
    }
    const entry = list.find((d) => d.entry === 'in') ?? list[0]!;
    let ref: string | null = entry.comment.includes(':') ? entry.comment.trim() : null;
    let plan: TradePlan | null = null;
    const command = await db.commands.findOne({ accountId: account._id, 'results.ticket': position });
    if (command) {
      ref = command.results!.find((r) => r.ticket === position)!.ref;
      plan = planOf(command, ref);
    }
    // the position side is the entry deal's direction
    const doc: TradeDoc = {
      _id: new ObjectId(),
      accountId: account._id,
      accountNumber: account.number,
      ticket: position,
      ref,
      symbol: incoming[0]!.symbol,
      side: entry.side,
      plan,
      deals: list,
      ...state,
      createdAt: now,
      updatedAt: now,
    };
    await db.trades.updateOne({ accountId: account._id, ticket: position }, { $setOnInsert: doc }, { upsert: true });
  }
  return { deals: deals.length, trades: byPosition.size };
}

export type JournalTrade = Omit<TradeDoc, '_id' | 'accountId' | 'deals'> & { id: string; deals: number; r: number | null };

function publicTrade(t: TradeDoc): JournalTrade {
  const { _id, accountId: _a, deals, ...rest } = t;
  return { id: _id.toHexString(), ...rest, deals: deals.length, r: t.plan?.risk && t.status === 'closed' ? Math.round((t.net / t.plan.risk) * 100) / 100 : null };
}

// Closed trades of [from, to) by close time, the levels placed in the same period for the
// fill rate (a level placed again by a later Execute counts once), and the open positions.
export async function journalFor(db: Collections, accountId: ObjectId, from: Date, to: Date): Promise<{ audit: Audit; trades: JournalTrade[]; open: JournalTrade[] }> {
  const closed = await db.trades.find({ accountId, status: 'closed', closedAt: { $gte: from, $lt: to } }).sort({ closedAt: 1 }).toArray();
  const placements = await db.trades.find({ accountId, 'plan.placedAt': { $gte: from, $lt: to } }, { projection: { status: 1, ref: 1, ticket: 1 } }).toArray();
  const levels = new Map<string, string[]>();
  for (const p of placements) {
    const key = p.ref ?? String(p.ticket);
    levels.set(key, [...(levels.get(key) ?? []), p.status]);
  }
  const placed = [...levels.values()];
  const open = await db.trades.find({ accountId, status: 'open' }).sort({ openedAt: 1 }).toArray();
  const rows: AuditTrade[] = closed.map((t) => ({
    symbol: t.symbol,
    side: t.side,
    openedAt: t.openedAt!,
    closedAt: t.closedAt!,
    openPrice: t.openPrice!,
    closeReason: t.closeReason!,
    net: t.net,
    plan: t.plan,
  }));
  const filled = placed.filter((s) => s.includes('open') || s.includes('closed')).length;
  const fills = {
    placed: placed.length,
    filled,
    cancelled: placed.filter((s) => s.every((x) => x === 'cancelled')).length,
    rate: placed.length ? filled / placed.length : null,
  };
  return {
    audit: audit(rows, fills, closed.filter((t) => !t.plan).length),
    trades: closed.map(publicTrade),
    open: open.map(publicTrade),
  };
}
