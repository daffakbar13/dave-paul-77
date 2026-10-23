import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type News, type NewsFeed } from '../api.ts';
import { ago, fmtWib } from '../format.ts';
import { Modal } from './Modal.tsx';

type Props = { pairs: string[]; onClose: () => void; onChanged: () => void };

type ImpactFilter = 'high' | 'medium' | 'all';
const FILTER_KEY = 'dp77-news-filter';

const IMPACT_LABEL: Record<string, string> = { high: 'Merah', medium: 'Oranye', low: 'Kuning' };
const RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
const MIN_RANK: Record<ImpactFilter, number> = { high: 3, medium: 2, all: 1 };

const dayLabelFmt = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' });
const wibDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(ms));

function loadFilter(): { impact: ImpactFilter; mine: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}');
    return { impact: v.impact === 'medium' || v.impact === 'all' ? v.impact : 'high', mine: v.mine !== false };
  } catch {
    return { impact: 'high', mine: true };
  }
}

// "dalam 45 mnt", "dalam 3 jam", "dalam 2 hari"
function until(ms: number): string {
  const min = Math.round((ms - Date.now()) / 60_000);
  if (min <= 0) return 'sudah rilis';
  if (min < 60) return `dalam ${min} mnt`;
  const h = Math.round(min / 60);
  return h < 48 ? `dalam ${h} jam` : `dalam ${Math.round(h / 24)} hari`;
}

// The whole calendar ahead (the feed covers the current week), grouped by WIB day.
export function NewsModal({ pairs, onClose, onChanged }: Props) {
  const [news, setNews] = useState<News[] | null>(null);
  const [status, setStatus] = useState<NewsFeed['status'] | null>(null);
  const [filter, setFilterState] = useState(loadFilter);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setFilter = (f: typeof filter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    } catch {
      // per-viewer convenience only
    }
  };

  const load = useCallback(async () => {
    try {
      const r = await api.upcomingNews();
      setNews(r.news);
      setStatus(r.status);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      await api.refreshNews();
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mine = useMemo(() => new Set(pairs.flatMap((p) => [p.slice(0, 3), p.slice(3, 6)])), [pairs]);
  const days = useMemo(() => {
    const out: { day: string; label: string; items: News[] }[] = [];
    for (const n of news ?? []) {
      if ((RANK[n.impact] ?? 0) < MIN_RANK[filter.impact]) continue;
      if (filter.mine && !mine.has(n.currency)) continue;
      const ms = new Date(n.at).getTime();
      const day = wibDay(ms);
      if (out.at(-1)?.day !== day) out.push({ day, label: day === wibDay(Date.now()) ? 'Hari ini' : dayLabelFmt.format(new Date(ms)), items: [] });
      out.at(-1)!.items.push(n);
    }
    return out;
  }, [news, filter, mine]);

  return (
    <Modal
      title="Berita mendatang"
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            Sumber {status?.source ?? '–'}, diambil {ago(status?.fetchedAt ?? null)}. Kalender hanya mencakup minggu ini.
          </span>
          <button type="button" onClick={refresh} disabled={busy}>
            {busy ? 'Memuat…' : 'Muat ulang'}
          </button>
        </>
      }
    >
      <div className="modal-tools">
        <div className="seg" role="group" aria-label="Dampak">
          {(['high', 'medium', 'all'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={filter.impact === k} onClick={() => setFilter({ ...filter, impact: k })}>
              {k === 'high' ? 'Merah' : k === 'medium' ? '+ Oranye' : 'Semua'}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={filter.mine} onChange={(e) => setFilter({ ...filter, mine: e.target.checked })} />
          Mata uang pair aktif saja
        </label>
        <span className="muted">Waktu WIB</span>
      </div>
      {error && <p className="error">{error}</p>}
      {status?.error && <p className="error">Kalender gagal diambil ({status.error}); data terakhir dipakai.</p>}
      {!news ? (
        <p className="muted pad">Memuat…</p>
      ) : !days.length ? (
        <p className="muted pad">Tidak ada berita untuk filter ini sampai akhir minggu.</p>
      ) : (
        days.map((d) => (
          <section key={d.day} className="news-day">
            <h3>{d.label}</h3>
            <ul className="news-list">
              {d.items.map((n) => {
                const ms = new Date(n.at).getTime();
                const past = ms < Date.now();
                return (
                  <li key={n.id} className={past ? 'past' : ''}>
                    <span className="tabular news-time">{fmtWib(n.at).replace(' WIB', '')}</span>
                    <span className={`impact impact-${n.impact}`} title={IMPACT_LABEL[n.impact]} aria-label={`dampak ${IMPACT_LABEL[n.impact]}`} />
                    <b className="news-cur">{n.currency}</b>
                    <span className="news-title">{n.title}</span>
                    <span className="muted news-until">{until(ms)}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </Modal>
  );
}
