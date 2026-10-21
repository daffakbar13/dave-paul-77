import type { AccountOrders } from '../api.ts';
import { ago, fmtMoney } from '../format.ts';

// Bottom of the Pending Orders / Execute modal: counts and risk per account and currency.
export function Summary({ data, named }: { data: AccountOrders; named?: boolean }) {
  const { account, summary } = data;
  const aggressiveRows = data.rows.filter((r) => r.status === 'valid' && r.multiplier > 1).length;
  const pct = account.balance ? (summary.totalRisk / account.balance) * 100 : null;
  return (
    <div className="summary tabular">
      {named && <b>{account.name}</b>}
      <span>
        <b>{summary.orders}</b> order
      </span>
      <span>
        Total risk <b>{fmtMoney(summary.totalRisk)}</b> {account.currency ?? ''}
        {pct !== null && <span className="muted"> ({pct.toFixed(2)}% balance)</span>}
      </span>
      <span>
        Per mata uang:{' '}
        {Object.entries(summary.byCurrency)
          .sort((a, b) => b[1] - a[1])
          .map(([cur, v]) => `${cur} ${fmtMoney(v)}`)
          .join(' · ') || '–'}
      </span>
      <span className={summary.lowRr ? 'low-rr-text' : 'muted'}>{summary.lowRr} baris RR rendah</span>
      {summary.running > 0 && <span className="running-text">{summary.running} posisi berjalan, levelnya tidak dikirim ulang</span>}
      {aggressiveRows > 0 && (
        <span className="aggr">
          Aggressive {account.multiplier}x di {aggressiveRows} order
        </span>
      )}
      {account.stale && <span className="warn">Balance terakhir sinkron {ago(account.balanceAt)}</span>}
    </div>
  );
}
