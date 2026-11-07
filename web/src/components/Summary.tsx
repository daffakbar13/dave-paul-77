import type { AccountOrders } from '../api.ts';
import { ago, fmtMoney } from '../format.ts';
import { useT } from '../i18n.ts';

type Props = { data: AccountOrders; named?: boolean; variant?: 'inline' | 'cards' };

// Counts and risk per account and currency: one line at the bottom of Pending Orders, or
// five cards at the top of the Execute view.
export function Summary({ data, named, variant = 'inline' }: Props) {
  const t = useT();
  const { account, summary } = data;
  const aggressiveRows = data.rows.filter((r) => r.status === 'valid' && r.multiplier > 1).length;
  const pct = account.balance ? (summary.totalRisk / account.balance) * 100 : null;
  const currencies = Object.entries(summary.byCurrency).sort((a, b) => b[1] - a[1]);

  const notes = (
    <>
      {aggressiveRows > 0 && (
        <span className="aggr">
          {t(`Aggressive ${account.multiplier}x di ${aggressiveRows} order`, `Aggressive ${account.multiplier}x on ${aggressiveRows} orders`)}
        </span>
      )}
      {account.stale && <span className="warn">{t('Balance terakhir sinkron', 'Balance last synced')} {ago(account.balanceAt)}</span>}
    </>
  );

  if (variant === 'cards') {
    return (
      <div className="summary-cards tabular">
        {named && (
          <h3>
            {account.name} <span className="muted">{account.number}</span>
          </h3>
        )}
        <div className="stat-cards">
          <div className="stat-card">
            <span className="stat-label">{t('Order dikirim', 'Orders to send')}</span>
            <b>{summary.orders}</b>
          </div>
          <div className="stat-card">
            <span className="stat-label">Total risk</span>
            <b>
              {fmtMoney(summary.totalRisk)} <small className="muted">{account.currency ?? ''}</small>
            </b>
            {pct !== null && <span className="muted">{t(`${pct.toFixed(2)}% dari balance`, `${pct.toFixed(2)}% of balance`)}</span>}
          </div>
          <div className="stat-card">
            <span className="stat-label">{t('Per mata uang', 'Per currency')}</span>
            <div className="per-currency">
              {currencies.map(([cur, v]) => (
                <span key={cur}>
                  <span>{cur}</span>
                  <span>{fmtMoney(v)}</span>
                </span>
              ))}
              {!currencies.length && <span>–</span>}
            </div>
          </div>
          <div className="stat-card">
            <span className="stat-label">{t('RR rendah', 'Low RR')}</span>
            <b className={summary.lowRr ? 'low-rr-text' : ''}>{summary.lowRr}</b>
            <span className="muted">{t('tetap dikirim, cek lagi', 'still sent, review it')}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">{t('Berjalan', 'Running')}</span>
            <b>{summary.running}</b>
            <span className="muted">{t('level tidak dikirim ulang', 'levels not resent')}</span>
          </div>
        </div>
        {(aggressiveRows > 0 || account.stale) && <div className="summary">{notes}</div>}
      </div>
    );
  }

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
        {t('Per mata uang', 'Per currency')}: {currencies.map(([cur, v]) => `${cur} ${fmtMoney(v)}`).join(' · ') || '–'}
      </span>
      <span className={summary.lowRr ? 'low-rr-text' : 'muted'}>{summary.lowRr} {t('baris RR rendah', 'low-RR rows')}</span>
      {summary.running > 0 && <span className="running-text">{t(`${summary.running} posisi berjalan, levelnya tidak dikirim ulang`, `${summary.running} running positions, their levels are not resent`)}</span>}
      {notes}
    </div>
  );
}
