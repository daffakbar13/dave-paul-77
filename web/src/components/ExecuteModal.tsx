import { useCallback, useEffect, useState } from 'react';
import { api, type Account, type AggressiveMode, type AccountOrders, type Command, type OrderRow } from '../api.ts';
import { ago } from '../format.ts';
import { Modal } from './Modal.tsx';
import { OrdersTable } from './OrdersTable.tsx';
import { Summary } from './Summary.tsx';

type Props = {
  accounts: Account[];
  initialAccountId: string | null;
  aggressive: AggressiveMode;
  onClose: () => void;
  onChanged: () => void;
};

// Always shown before anything is sent. Rows are recomputed by the server on Confirm,
// so what lands in the queue matches this table at that moment.
export function ExecuteModal({ accounts, initialAccountId, aggressive, onClose, onChanged }: Props) {
  const [selected, setSelected] = useState<string[]>(initialAccountId ? [initialAccountId] : []);
  const [preview, setPreview] = useState<AccountOrders[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<Command[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selected.length) {
      setPreview([]);
      return;
    }
    try {
      setPreview((await api.preview(selected, aggressive)).accounts);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selected, aggressive]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

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

  const confirm = async () => {
    setSending(true);
    try {
      setSent((await api.execute(selected, aggressive)).commands);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <Modal title="Perintah terkirim" onClose={onClose} footer={<button type="button" className="primary" onClick={onClose}>Selesai</button>}>
        <ul className="sent">
          {sent.map((c) => (
            <li key={c.id}>
              <b>{accounts.find((a) => a.id === c.accountId)?.name}</b> ({c.accountNumber}): {c.orders.length} order menunggu EA MT5.
            </li>
          ))}
        </ul>
        <p className="muted">
          Nyalakan MT5 dan login ke akun tujuan. EA mengambil perintahnya, menghapus pending order ber-magic number aplikasi, lalu
          memasang yang baru. Status bisa dilihat di Pending Orders, tab Perintah ke MT5.
        </p>
      </Modal>
    );
  }

  const valid = preview?.reduce((n, p) => n + p.summary.orders, 0) ?? 0;
  // a cancel applies to every account, so count each level once
  const cancelled = new Set(preview?.flatMap((p) => p.rows.filter((r) => r.status === 'cancelled').map((r) => r.id)) ?? []).size;

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
  const empty = preview?.filter((p) => p.summary.orders === 0) ?? [];

  return (
    <Modal
      title="Execute"
      onClose={onClose}
      wide
      footer={
        <>
          <div className="foot-notes">
            {preview?.map((p) => <Summary key={p.account.id} data={p} named={preview.length > 1} />)}
            {empty.length > 0 && (
              <p className="warn">
                {empty.map((p) => p.account.name).join(', ')}: tidak ada order valid. Confirm tetap menghapus pending order aplikasi di
                akun itu.
              </p>
            )}
          </div>
          <div className="foot-actions">
            <button type="button" onClick={onClose}>
              Batal
            </button>
            <button type="button" className="primary" disabled={!selected.length || sending || !preview} onClick={confirm}>
              {sending ? 'Mengirim…' : `Confirm (${valid} order)`}
            </button>
          </div>
        </>
      }
    >
      <fieldset className="accounts-pick">
        <legend>Akun tujuan</legend>
        {accounts.map((a) => (
          <label key={a.id} className="check">
            <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} />
            {a.name} <span className="muted tabular">{a.number} · sinkron {ago(a.balanceAt)}</span>
          </label>
        ))}
        {!accounts.length && <span className="muted">Belum ada akun. Tambahkan di Pengaturan.</span>}
      </fieldset>
      {aggressive === 'on' && <p className="aggr">Aggressive manual: risk semua pair dikali pengali tiap akun.</p>}
      {aggressive === 'auto' && preview?.some((p) => p.rows.some((r) => r.multiplier > 1)) && (
        <p className="aggr">Aggressive otomatis: risk dikali untuk pair yang mata uangnya ada berita merah (lihat penanda di kolom risk).</p>
      )}
      {error && <p className="error">{error}</p>}
      {cancelled > 0 && (
        <div className="modal-tools">
          <span className="muted">{cancelled} order dibatalkan dan tidak ikut dikirim.</span>
          <button type="button" className="restore-all" disabled={busyId !== null} title="Kembalikan semua order yang dibatalkan dengan X, di semua pair" onClick={restoreAll}>
            Pulihkan semua ({cancelled})
          </button>
        </div>
      )}
      {preview?.map((p) => (
        <section key={p.account.id} className="exec-account">
          {preview.length > 1 && (
            <h3>
              {p.account.name} <span className="muted tabular">{p.account.number}</span>
            </h3>
          )}
          <OrdersTable rows={p.rows} busyId={busyId} onCancel={(r) => act(r, api.cancel)} onRestore={(r) => act(r, api.restore)} />
        </section>
      ))}
    </Modal>
  );
}
