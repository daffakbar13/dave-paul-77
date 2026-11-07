import type { OrderRow } from '../api.ts';
import { digitsOf, fmtLot, fmtMoney, fmtPrice, fmtRr } from '../format.ts';
import { engineText, tr, useT } from '../i18n.ts';

type Props = {
  rows: OrderRow[];
  onCancel: (row: OrderRow) => void;
  onRestore: (row: OrderRow) => void;
  busyId: string | null;
};

export const statusText = (): Record<OrderRow['status'], string> => ({
  valid: 'Valid',
  skipped: tr('Dilewati', 'Skipped'),
  invalid: tr('Tidak valid', 'Invalid'),
  cancelled: tr('Dibatalkan', 'Cancelled'),
  running: tr('Posisi berjalan', 'Running position'),
});

// Pending Orders / Execute table. Every row stays visible with its reason; only valid
// rows are sent.
export function OrdersTable({ rows, onCancel, onRestore, busyId }: Props) {
  const t = useT();
  if (!rows.length) return <p className="muted pad">{t('Belum ada kandidat order.', 'No order candidates yet.')}</p>;
  const STATUS_TEXT = statusText();
  // pair A-Z, then price high to low (a skipped row has no entry, so its line stands in)
  const sorted = [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol) || (b.entry ?? b.line) - (a.entry ?? a.line));
  return (
    <div className="table-scroll">
      <table className="orders tabular">
        <thead>
          <tr>
            <th>Pair</th>
            <th>{t('Tipe', 'Type')}</th>
            <th className="num">Entry</th>
            <th className="num">SL</th>
            <th className="num">TP</th>
            <th className="num">Lot</th>
            <th className="num">Risk</th>
            <th className="num">RR</th>
            <th>Status</th>
            <th aria-label={t('Aksi', 'Action')} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const d = digitsOf(r.symbol);
            const cls = [`row-${r.status}`, r.status === 'valid' && r.lowRr ? 'row-low-rr' : ''].join(' ');
            return (
              <tr key={r.id} className={cls}>
                <td>{r.symbol}</td>
                <td>{r.type}</td>
                <td className="num entry">{fmtPrice(r.entry, d)}</td>
                <td className="num sltp">
                  {fmtPrice(r.sl, d)}
                  {r.slFrom === 'ladder' && r.sl !== null && <span className="tag" title={t('Tidak ada candle kuat di sisi SL garis ini', 'No strong candle on the SL side of this line')}>{t('SL tangga', 'SL ladder')}</span>}
                </td>
                <td className="num sltp">
                  {fmtPrice(r.tp, d)}
                  {r.tpAuto && <span className="tag">TP auto</span>}
                </td>
                <td className="num">{fmtLot(r.lot)}</td>
                <td className="num">
                  {fmtMoney(r.risk)}
                  {r.multiplier > 1 && r.status === 'valid' && <span className="aggr"> {r.multiplier}x</span>}
                </td>
                <td className={`num${r.status === 'valid' && r.lowRr ? ' low-rr-text' : ''}`}>{fmtRr(r.rr)}</td>
                <td className="status">
                  <span className={`pill pill-${r.status === 'valid' && r.lowRr ? 'low-rr' : r.status}`}>
                    {STATUS_TEXT[r.status]}
                    {r.status === 'valid' && r.lowRr && t(' · RR rendah', ' · low RR')}
                  </span>
                  {r.reason && r.status !== 'cancelled' && <span className="reason">{engineText(r.reason)}</span>}
                </td>
                <td className="act">
                  {r.status === 'cancelled' ? (
                    <button type="button" className="link" disabled={busyId === r.id} onClick={() => onRestore(r)}>
                      {t('Pulihkan', 'Restore')}
                    </button>
                  ) : r.status !== 'skipped' && r.status !== 'running' ? (
                    <button type="button" className="x" aria-label={t(`Batalkan ${r.symbol} ${r.type}`, `Cancel ${r.symbol} ${r.type}`)} disabled={busyId === r.id} onClick={() => onCancel(r)}>
                      ×
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
