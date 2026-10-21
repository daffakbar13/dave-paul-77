import { useCallback, useEffect, useState } from 'react';
import { api, type Account, type AggressiveMode, type AccountOrders, type Command, type OrderRow } from '../api.ts';
import { ago, fmtWib } from '../format.ts';
import { Modal } from './Modal.tsx';
import { OrdersTable } from './OrdersTable.tsx';
import { Summary } from './Summary.tsx';

type Props = {
  account: Account | null;
  accounts: Account[];
  aggressive: AggressiveMode;
  onClose: () => void;
  onChanged: () => void;
};

const COMMAND_STATUS: Record<Command['status'], string> = {
  pending: 'Menunggu',
  taken: 'Diambil EA',
  done: 'Berhasil',
  failed: 'Gagal',
  expired: 'Kedaluwarsa',
  superseded: 'Diganti',
};

export function PendingModal({ account, accounts, aggressive, onClose, onChanged }: Props) {
  const [tab, setTab] = useState<'orders' | 'commands'>('orders');
  const [data, setData] = useState<AccountOrders | null>(null);
  const [commands, setCommands] = useState<Command[] | null>(null);
  const [hideSkipped, setHideSkipped] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (tab === 'orders' && account) setData(await api.orders(account.id, aggressive));
      if (tab === 'commands') setCommands((await api.commands()).commands);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tab, account, aggressive]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (row: OrderRow, fn: (id: string) => Promise<unknown>) => {
    setBusyId(row.id);
    try {
      await fn(row.id);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const rows = data ? (hideSkipped ? data.rows.filter((r) => r.status !== 'skipped') : data.rows) : [];
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;

  return (
    <Modal title="Pending Orders" onClose={onClose} wide footer={tab === 'orders' && data ? <Summary data={data} /> : undefined}>
      <div className="modal-tools">
        <div className="seg" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'orders'} onClick={() => setTab('orders')}>
            Kandidat{account ? ` · ${account.name}` : ''}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'commands'} onClick={() => setTab('commands')}>
            Perintah ke MT5
          </button>
        </div>
        {tab === 'orders' && (
          <label className="check">
            <input type="checkbox" checked={hideSkipped} onChange={(e) => setHideSkipped(e.target.checked)} /> Sembunyikan yang dilewati
          </label>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {tab === 'orders' && !account && <p className="muted pad">Tambahkan akun MT5 di Pengaturan dulu.</p>}
      {tab === 'orders' && data && (
        <OrdersTable rows={rows} busyId={busyId} onCancel={(r) => act(r, api.cancel)} onRestore={(r) => act(r, api.restore)} />
      )}
      {tab === 'commands' && commands && (
        commands.length ? (
          <div className="table-scroll">
            <table className="orders tabular">
              <thead>
                <tr>
                  <th>Dibuat</th>
                  <th>Akun</th>
                  <th className="num">Order</th>
                  <th>Status</th>
                  <th>Hasil</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((c) => {
                  const failed = c.results?.filter((r) => !r.ok) ?? [];
                  return (
                    <tr key={c.id} className={c.status === 'failed' ? 'row-invalid' : ''}>
                      <td>
                        {fmtWib(c.createdAt)} <span className="muted">({ago(c.createdAt)})</span>
                      </td>
                      <td>{nameOf(c.accountId)}</td>
                      <td className="num">{c.orders.length}</td>
                      <td className="status">
                        {COMMAND_STATUS[c.status]}
                        {c.dryRun && <span className="tag">dry-run</span>}
                      </td>
                      <td>
                        {c.results
                          ? `${c.results.length - failed.length} berhasil, ${failed.length} gagal`
                          : '–'}
                        {failed.map((f) => (
                          <span key={f.ref} className="reason">
                            {f.ref}: {f.error}
                          </span>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted pad">Belum ada perintah.</p>
        )
      )}
    </Modal>
  );
}
