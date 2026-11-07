import type { AccountOrders } from '../api.ts';
import { ago, fmtMoney } from '../format.ts';
import { useT } from '../i18n.ts';

// Bottom of the Pending Orders / Execute modal: counts and risk per account and currency.
export function Summary({ data, named }: { data: AccountOrders; named?: boolean }) {
  const t = useT();
  const { account, summary } = data;
  const aggressiveRows = data.rows.filter((r) => r.status === 'valid' && r.multiplier > 1).length;
  const pct = account.balance ? (summary.totalRisk / account.balance) * 100 : null;
  return (
    <div className="summary tabular">
      {named && <b>{account.name}</b>}
      <span>
        <b>{summary.orders}</b> {t('order', 'orders')}
      </span>
      <span>
        Total risk <b>{fmtMoney(summary.totalRisk)}</b> {account.currency ?? ''}
        {pct !== null && <span className="muted"> ({pct.toFixed(2)}% balance)</span>}
      </span>
      <span>
        {t('Per mata uang', 'Per currency')}:{' '}
        {Object.entries(summary.byCurrency)
          .sort((a, b) => b[1] - a[1])
          .map(([cur, v]) => `${cur} ${fmtMoney(v)}`)
          .join(' · ') || '–'}
      </span>
      <span className={summary.lowRr ? 'low-rr-text' : 'muted'}>{summary.lowRr} {t('baris RR rendah', 'low-RR rows')}</span>
      {summary.running > 0 && <span className="running-text">{t(`${summary.running} posisi berjalan, levelnya tidak dikirim ulang`, `${summary.running} running positions, their levels are not resent`)}</span>}
      {aggressiveRows > 0 && (
        <span className="aggr">
          {t(`Aggressive ${account.multiplier}x di ${aggressiveRows} order`, `Aggressive ${account.multiplier}x on ${aggressiveRows} orders`)}
        </span>
      )}
      {account.stale && <span className="warn">{t('Balance terakhir sinkron', 'Balance last synced')} {ago(account.balanceAt)}</span>}
    </div>
  );
}
