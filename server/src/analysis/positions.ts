// Open positions reported by the MT5 EA, matched back to the levels they came from, so
// Execute never places a level again while its position is still running.
import type { OrderRow } from './orders.ts';
import type { Side } from './types.ts';

export type OpenPosition = {
  ticket: number;
  symbol: string; // app symbol (broker suffix mapped back)
  side: Side;
  volume: number;
  openPrice: number;
  sl: number;
  tp: number;
  comment: string; // the level id from the pending order, when the broker keeps it
};

// A fill can slip by spread and liquidity, so price matching allows 30% of the
// entry-to-SL distance; the order comment (level id) is tried first.
export const PRICE_TOLERANCE = 0.3;

export function markRunning(rows: OrderRow[], positions: OpenPosition[]): OrderRow[] {
  if (!positions.length) return rows;
  const byRow = new Map<string, OpenPosition>();
  const used = new Set<number>();

  for (const p of positions) {
    const row = rows.find((r) => r.id === p.comment.trim() && r.symbol === p.symbol && r.side === p.side);
    if (row && !byRow.has(row.id)) {
      byRow.set(row.id, p);
      used.add(p.ticket);
    }
  }

  // Fallback: nearest level of the same pair and side within the tolerance, closest
  // pairs first so one position never claims a level another fits better.
  const pairs: { row: OrderRow; p: OpenPosition; d: number }[] = [];
  for (const p of positions) {
    if (used.has(p.ticket)) continue;
    for (const row of rows) {
      if (byRow.has(row.id) || row.symbol !== p.symbol || row.side !== p.side || row.entry === null || row.sl === null) continue;
      const d = Math.abs(p.openPrice - row.entry);
      if (d <= PRICE_TOLERANCE * Math.abs(row.entry - row.sl)) pairs.push({ row, p, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  for (const { row, p } of pairs) {
    if (byRow.has(row.id) || used.has(p.ticket)) continue;
    byRow.set(row.id, p);
    used.add(p.ticket);
  }

  return rows.map((r) => {
    const p = byRow.get(r.id);
    if (!p) return r;
    return { ...r, status: 'running', reason: `Posisi berjalan #${p.ticket}: ${p.volume} lot @ ${p.openPrice}`, position: p.ticket };
  });
}
