import type { OrderRow } from '../api.ts';
import { digitsOf, fmtLot, fmtMoney, fmtPrice, fmtRr } from '../format.ts';

type Props = {
  rows: OrderRow[];
  onCancel: (row: OrderRow) => void;
  onRestore: (row: OrderRow) => void;
  busyId: string | null;
};

const STATUS_TEXT: Record<OrderRow['status'], string> = {
  valid: 'Valid',
  skipped: 'Dilewati',
  invalid: 'Tidak valid',
  cancelled: 'Dibatalkan',
  running: 'Posisi berjalan',
};

// Pending Orders / Execute table. Every row stays visible with its reason; only valid
// rows are sent.
export function OrdersTable({ rows, onCancel, onRestore, busyId }: Props) {
  if (!rows.length) return <p className="muted pad">Belum ada kandidat order.</p>;
  return (
    <div className="table-scroll">
      <table className="orders tabular">
        <thead>
          <tr>
            <th>Pair</th>
            <th>Tipe</th>
            <th className="num">Entry</th>
            <th className="num">SL</th>
            <th className="num">TP</th>
            <th className="num">Lot</th>
            <th className="num">Risk</th>
            <th className="num">RR</th>
            <th>Status</th>
            <th aria-label="Aksi" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = digitsOf(r.symbol);
            const cls = [`row-${r.status}`, r.status === 'valid' && r.lowRr ? 'row-low-rr' : ''].join(' ');
            return (
              <tr key={r.id} className={cls}>
                <td>{r.symbol}</td>
                <td>{r.type}</td>
                <td className="num">{fmtPrice(r.entry, d)}</td>
                <td className="num">
                  {fmtPrice(r.sl, d)}
                  {r.slFrom === 'ladder' && r.sl !== null && <span className="tag" title="Tidak ada candle kuat di sisi SL garis ini">SL tangga</span>}
                </td>
                <td className="num">
                  {fmtPrice(r.tp, d)}
                  {r.tpAuto && <span className="tag">TP auto</span>}
                </td>
                <td className="num">{fmtLot(r.lot)}</td>
                <td className="num">
                  {fmtMoney(r.risk)}
                  {r.multiplier > 1 && r.status === 'valid' && <span className="aggr"> {r.multiplier}x</span>}
                </td>
                <td className="num">{fmtRr(r.rr)}</td>
                <td className="status">
                  {STATUS_TEXT[r.status]}
                  {r.status === 'valid' && r.lowRr && ' · RR rendah'}
                  {r.reason && r.status !== 'cancelled' && <span className="reason">{r.reason}</span>}
                </td>
                <td className="act">
                  {r.status === 'cancelled' ? (
                    <button type="button" className="link" disabled={busyId === r.id} onClick={() => onRestore(r)}>
                      Pulihkan
                    </button>
                  ) : r.status !== 'skipped' && r.status !== 'running' ? (
                    <button type="button" className="x" aria-label={`Batalkan ${r.symbol} ${r.type}`} disabled={busyId === r.id} onClick={() => onCancel(r)}>
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
