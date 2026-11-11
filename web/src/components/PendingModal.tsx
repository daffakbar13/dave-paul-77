import { useCallback, useEffect, useState } from 'react';
import { api, type Account, type AggressiveMode, type AccountOrders, type Command, type OrderRow } from '../api.ts';
import { ago, fmtWib } from '../format.ts';
import { tr, useT } from '../i18n.ts';
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

const commandStatus = (): Record<Command['status'], string> => ({
  pending: tr('Menunggu', 'Waiting'),
  taken: tr('Diambil EA', 'Taken by EA'),
  done: tr('Berhasil', 'Succeeded'),
  failed: tr('Gagal', 'Failed'),
  expired: tr('Kedaluwarsa', 'Expired'),
  superseded: tr('Diganti', 'Superseded'),
});

export function PendingModal({ account, accounts, aggressive, onClose, onChanged }: Props) {
  const t = useT();
  const COMMAND_STATUS = commandStatus();
  const [data, setData] = useState<AccountOrders | null>(null);
  const [commands, setCommands] = useState<Command[] | null>(null);
  const [hideSkipped, setHideSkipped] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // candidates and commands sit side by side, so both load together
  const load = useCallback(async () => {
    try {
      const [orders, sent] = await Promise.all([account ? api.orders(account.id, aggressive) : null, api.commands()]);
      setData(orders);
      setCommands(sent.commands);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [account, aggressive]);

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
  const cancelled = data?.rows.filter((r) => r.status === 'cancelled').length ?? 0;

  const restoreAll = async () => {
    setBusyId('*');
    try {
      await api.restoreAll();
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;

  return (
    <Modal title="Pending Orders" onClose={onClose} wide footer={data ? <Summary data={data} /> : undefined}>
      {error && <p className="error">{error}</p>}
      <div className="pending-split">
        <section>
          <div className="modal-tools">
            <h3>
              {t('Kandidat', 'Candidates')}{account ? ` · ${account.name}` : ''}
            </h3>
            <label className="check">
              <input type="checkbox" checked={hideSkipped} onChange={(e) => setHideSkipped(e.target.checked)} /> {t('Sembunyikan yang dilewati', 'Hide skipped')}
            </label>
            {cancelled > 0 && (
              <button type="button" className="restore-all" disabled={busyId !== null} title={t('Kembalikan semua order yang dibatalkan dengan X, di semua pair', 'Restore all orders cancelled with X, on all pairs')} onClick={restoreAll}>
                {t('Pulihkan semua', 'Restore all')} ({cancelled})
              </button>
            )}
          </div>
          {!account && <p className="muted pad">{t('Tambahkan akun MT5 di Pengaturan dulu.', 'Add an MT5 account in Settings first.')}</p>}
          {data && <OrdersTable rows={rows} busyId={busyId} onCancel={(r) => act(r, api.cancel)} onRestore={(r) => act(r, api.restore)} />}
        </section>
        <aside aria-label={t('Perintah ke MT5', 'Commands to MT5')}>
          <div className="modal-tools">
            <h3>{t('Perintah ke MT5', 'Commands to MT5')}</h3>
          </div>
          {commands &&
            (commands.length ? (
              <ul className="cmd-list tabular">
                {commands.map((c) => {
                  const failed = c.results?.filter((r) => !r.ok) ?? [];
                  return (
                    <li key={c.id} className={`cmd${c.status === 'failed' ? ' cmd-failed' : ''}`}>
                      <div className="cmd-head">
                        <b>{nameOf(c.accountId)}</b>
                        <span className={`pill pill-${c.status}`}>
                          {COMMAND_STATUS[c.status]}
                          {c.dryRun && <span className="tag">dry-run</span>}
                        </span>
                      </div>
                      <span className="muted">
                        {fmtWib(c.createdAt)} ({ago(c.createdAt)}) · {c.orders.length} order
                      </span>
                      {c.results && <span>{t(`${c.results.length - failed.length} berhasil, ${failed.length} gagal`, `${c.results.length - failed.length} succeeded, ${failed.length} failed`)}</span>}
                      {c.deleted !== undefined && (
                        <span className="reason muted">
                          {t(`${c.deleted} pending order lama ${c.dryRun ? 'akan dihapus' : 'dihapus'}`, `${c.deleted} old pending orders ${c.dryRun ? 'would be deleted' : 'deleted'}`)}
                        </span>
                      )}
                      {failed.map((f) => (
                        <span key={f.ref} className="reason reason-error">
                          {f.ref}: {f.error}
                        </span>
                      ))}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted pad">{t('Belum ada perintah.', 'No commands yet.')}</p>
            ))}
        </aside>
      </div>
    </Modal>
  );
}
