import { useCallback, useEffect, useState } from 'react';
import { api, type Account, type AggressiveMode, type AccountOrders, type Command, type OrderRow } from '../api.ts';
import { ago, fmtMoney } from '../format.ts';
import { useT } from '../i18n.ts';
import { OrdersTable } from './OrdersTable.tsx';
import { Summary } from './Summary.tsx';

type Props = {
  accounts: Account[];
  initialAccountId: string | null;
  aggressive: AggressiveMode;
  aggrActive: boolean;
  aggrLabel: string;
  onClose: () => void;
  onChanged: () => void;
};

// Full-screen review, always shown before anything is sent. Rows are recomputed by the
// server on Confirm, so what lands in the queue matches this table at that moment.
export function ExecuteView({ accounts, initialAccountId, aggressive, aggrActive, aggrLabel, onClose, onChanged }: Props) {
  const t = useT();
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

  // Esc goes back to the chart, as it closed the modal before
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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

  const valid = preview?.reduce((n, p) => n + p.summary.orders, 0) ?? 0;
  // a cancel applies to every account, so count each level once
  const cancelled = new Set(preview?.flatMap((p) => p.rows.filter((r) => r.status === 'cancelled').map((r) => r.id)) ?? []).size;
  const empty = preview?.filter((p) => p.summary.orders === 0) ?? [];

  const header = (
    <header className="topbar exec-top">
      <button type="button" className="back" onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        {t('Kembali ke grafik', 'Back to chart')}
      </button>
      <span className="crumb-sep" aria-hidden="true">
        /
      </span>
      <h1>Execute</h1>
      {aggrActive && (
        <span className="aggr-badge">
          <span className="pill-dot" aria-hidden="true" />
          {aggrLabel}
        </span>
      )}
    </header>
  );

  if (sent) {
    return (
      <div className="app exec">
        {header}
        <div className="exec-main">
          <h2 className="exec-title">{t('Perintah terkirim', 'Commands sent')}</h2>
          <ul className="sent">
            {sent.map((c) => (
              <li key={c.id}>
                <b>{accounts.find((a) => a.id === c.accountId)?.name}</b> ({c.accountNumber}): {t(`${c.orders.length} order menunggu EA MT5.`, `${c.orders.length} orders waiting for the MT5 EA.`)}
              </li>
            ))}
          </ul>
          <p className="muted">
            {t(
              'Nyalakan MT5 dan login ke akun tujuan. EA mengambil perintahnya, menghapus pending order ber-magic number aplikasi, lalu memasang yang baru. Status bisa dilihat di Pending Orders, tab Perintah ke MT5.',
              'Start MT5 and log in to the target account. The EA picks up the command, deletes the pending orders carrying the app magic number, then places the new ones. Status is shown in Pending Orders, tab Commands to MT5.'
            )}
          </p>
        </div>
        <footer className="exec-foot">
          <div className="exec-foot-inner">
            <div className="foot-actions">
              <button type="button" className="primary" onClick={onClose}>
                {t('Selesai', 'Done')}
              </button>
            </div>
          </div>
        </footer>
      </div>
    );
  }

  const targets = preview?.map((p) => p.account.name).join(', ') ?? '';

  return (
    <div className="app exec">
      {header}
      <div className="exec-main">
        <div className="exec-intro">
          <div>
            <h2 className="exec-title">{t('Tinjau sebelum kirim ke MT5', 'Review before sending to MT5')}</h2>
            <p className="muted">{t('Setiap baris tetap tampil dengan alasannya. Hanya baris valid yang dikirim ke EA.', 'Every row stays visible with its reason. Only valid rows are sent to the EA.')}</p>
          </div>
          {/* several accounts can be picked at once, so these are toggles, not single tabs */}
          <div className="account-tabs" role="group" aria-label={t('Akun tujuan', 'Target accounts')}>
            {accounts.map((a) => (
              <button key={a.id} type="button" aria-pressed={selected.includes(a.id)} title={`${a.number} · ${t('sinkron', 'synced')} ${ago(a.balanceAt)}`} onClick={() => toggle(a.id)}>
                {a.name}{' '}
                {a.balanceAt ? (
                  <span className="mono muted">
                    {fmtMoney(a.balance)} {a.currency ?? ''}
                  </span>
                ) : (
                  <span className="warn">· {t('balance belum sinkron', 'balance not synced')}</span>
                )}
              </button>
            ))}
            {!accounts.length && <span className="muted">{t('Belum ada akun. Tambahkan di Pengaturan.', 'No accounts yet. Add one in Settings.')}</span>}
          </div>
        </div>

        {aggressive === 'on' && <p className="aggr">{t('Aggressive manual: risk semua pair dikali pengali tiap akun.', 'Manual Aggressive: risk on all pairs is multiplied by each account multiplier.')}</p>}
        {aggressive === 'auto' && preview?.some((p) => p.rows.some((r) => r.multiplier > 1)) && (
          <p className="aggr">
            {t(
              'Aggressive otomatis: risk dikali untuk pair yang mata uangnya ada berita merah (lihat penanda di kolom risk).',
              'Automatic Aggressive: risk is multiplied for pairs whose currency has red news (see the marker in the risk column).'
            )}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {empty.length > 0 && (
          <p className="warn">
            {empty.map((p) => p.account.name).join(', ')}:{' '}
            {t('tidak ada order valid. Confirm tetap menghapus pending order aplikasi di akun itu.', 'no valid orders. Confirm still deletes the app pending orders on that account.')}
          </p>
        )}
        {cancelled > 0 && (
          <div className="modal-tools">
            <span className="muted">{t(`${cancelled} order dibatalkan dan tidak ikut dikirim.`, `${cancelled} orders cancelled and not sent.`)}</span>
            <button type="button" className="restore-all" disabled={busyId !== null} title={t('Kembalikan semua order yang dibatalkan dengan X, di semua pair', 'Restore all orders cancelled with X, on all pairs')} onClick={restoreAll}>
              {t('Pulihkan semua', 'Restore all')} ({cancelled})
            </button>
          </div>
        )}

        {preview?.map((p) => (
          <section key={p.account.id} className="exec-account">
            <Summary data={p} named={preview.length > 1} variant="cards" />
            <OrdersTable rows={p.rows} busyId={busyId} onCancel={(r) => act(r, api.cancel)} onRestore={(r) => act(r, api.restore)} />
          </section>
        ))}
        {!preview && <p className="muted">{t('Memuat…', 'Loading…')}</p>}
      </div>

      <footer className="exec-foot">
        <div className="exec-foot-inner">
          <span className="muted tabular">
            {t('Mengirim', 'Sending')} <b>{t(`${valid} order`, `${valid} orders`)}</b> {t('ke', 'to')} <b>{targets || '–'}</b>
            {preview?.map((p) => (
              <span key={p.account.id}>
                {' '}
                · risk <b className="mono">{fmtMoney(p.summary.totalRisk)} {p.account.currency ?? ''}</b>
              </span>
            ))}
          </span>
          <div className="foot-actions">
            <button type="button" onClick={onClose}>
              {t('Batal', 'Cancel')}
            </button>
            <button type="button" className="primary" disabled={!selected.length || sending || !preview} onClick={confirm}>
              {sending ? t('Mengirim…', 'Sending…') : t('Confirm & kirim ke MT5', 'Confirm & send to MT5')}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
