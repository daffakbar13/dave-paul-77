import type { OrderRow } from '../api.ts';
import { fmtLot, fmtMoney, fmtPrice, fmtRr } from '../format.ts';
import { engineText, useT } from '../i18n.ts';
import { statusText } from './OrdersTable.tsx';

type Props = {
  symbol: string;
  rows: OrderRow[];
  digits: number;
  currency: string | null;
  focusId: string | null;
  busyId: string | null;
  onFocus: (id: string | null) => void;
  onCancel: (row: OrderRow) => void;
  onRestore: (row: OrderRow) => void;
  onRestoreAll: () => void;
  onExecute: () => void;
};

// Right panel of the main screen: the current pair's order candidates as cards. Clicking a
// card focuses its lines on the chart, like clicking its label there.
export function OrdersPanel({ symbol, rows, digits, currency, focusId, busyId, onFocus, onCancel, onRestore, onRestoreAll, onExecute }: Props) {
  const t = useT();
  const STATUS_TEXT = statusText();
  // price high to low, as on the chart; a skipped row has no entry, so its line stands in
  const sorted = [...rows].sort((a, b) => (b.entry ?? b.line) - (a.entry ?? a.line));
  const cancelled = rows.filter((r) => r.status === 'cancelled').length;
  const valid = rows.filter((r) => r.status === 'valid');
  const risk = valid.reduce((n, r) => n + (r.risk ?? 0), 0);

  return (
    <aside className="orders-panel" aria-label={t('Kandidat order', 'Order candidates')}>
      <div className="panel-head">
        <h2>
          {t('Kandidat order', 'Order candidates')} <span className="muted">· {symbol}</span>
        </h2>
        {cancelled > 0 && (
          <button type="button" className="link" disabled={busyId !== null} title={t(`Kembalikan semua order ${symbol} yang dibatalkan dengan X`, `Restore all ${symbol} orders cancelled with X`)} onClick={onRestoreAll}>
            {t('Pulihkan semua', 'Restore all')} ({cancelled})
          </button>
        )}
      </div>

      <div className="cards">
        {!sorted.length && <p className="muted pad">{t('Belum ada kandidat order.', 'No order candidates yet.')}</p>}
        {sorted.map((r) => {
          if (r.status === 'cancelled') {
            return (
              <article key={r.id} className="order-card cancelled">
                <span className="order-type">
                  {r.type} @ <span className="mono">{fmtPrice(r.entry ?? r.line, digits)}</span>
                </span>
                <span className="pill">{STATUS_TEXT.cancelled}</span>
                <button type="button" className="link restore" disabled={busyId === r.id} onClick={() => onRestore(r)}>
                  {t('Pulihkan', 'Restore')}
                </button>
              </article>
            );
          }
          const focused = focusId === r.id;
          const lowRr = r.status === 'valid' && r.lowRr;
          const canCancel = r.status !== 'skipped' && r.status !== 'running';
          return (
            <article key={r.id} className={`order-card status-${r.status}${focused ? ' focused' : ''}`} onClick={() => onFocus(focused ? null : r.id)}>
              <div className="order-head">
                <button type="button" className="order-type" aria-pressed={focused} onClick={(e) => { e.stopPropagation(); onFocus(focused ? null : r.id); }}>
                  {r.status === 'running' ? `${r.side} · ${t('posisi', 'position')} #${r.position}` : r.type}
                </button>
                <span className={`pill pill-${lowRr ? 'low-rr' : r.status}`}>
                  {STATUS_TEXT[r.status]}
                  {lowRr && t(' · RR rendah', ' · low RR')}
                </span>
                {r.multiplier > 1 && r.status === 'valid' && <span className="pill pill-aggr">{r.multiplier}x</span>}
                {canCancel && (
                  <button
                    type="button"
                    className="x card-x"
                    aria-label={t(`Batalkan ${r.symbol} ${r.type}`, `Cancel ${r.symbol} ${r.type}`)}
                    disabled={busyId === r.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancel(r);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              <dl className="levels tabular">
                <div>
                  <dt>Entry</dt>
                  <dd className="entry">{fmtPrice(r.entry, digits)}</dd>
                </div>
                <div>
                  <dt>
                    SL{r.slFrom === 'ladder' && r.sl !== null && <span className="dt-note" title={t('Tidak ada candle kuat di sisi SL garis ini', 'No strong candle on the SL side of this line')}> {t('tangga', 'ladder')}</span>}
                  </dt>
                  <dd className="sltp">{fmtPrice(r.sl, digits)}</dd>
                </div>
                <div>
                  <dt>TP{r.tpAuto && <span className="dt-note"> auto</span>}</dt>
                  <dd className="sltp">{fmtPrice(r.tp, digits)}</dd>
                </div>
                <div>
                  <dt>Lot</dt>
                  <dd>{fmtLot(r.lot)}</dd>
                </div>
                <div>
                  <dt>Risk</dt>
                  <dd>{fmtMoney(r.risk)}</dd>
                </div>
                <div>
                  <dt>RR</dt>
                  <dd className={r.lowRr ? 'low-rr-text' : ''}>{fmtRr(r.rr)}</dd>
                </div>
              </dl>
              {r.reason && <p className="order-reason">{engineText(r.reason)}</p>}
            </article>
          );
        })}
      </div>

      <div className="panel-foot">
        <div className="panel-stats tabular">
          <div>
            <span>{t('Order valid · pair ini', 'Valid orders · this pair')}</span>
            <b className="mono">{valid.length}</b>
          </div>
          <div>
            <span>Total risk</span>
            <b className="mono">
              {fmtMoney(risk)} <small className="muted">{currency ?? ''}</small>
            </b>
          </div>
        </div>
        <button type="button" className="primary big" onClick={onExecute}>
          {t('Tinjau & execute', 'Review & execute')}
        </button>
      </div>
    </aside>
  );
}
