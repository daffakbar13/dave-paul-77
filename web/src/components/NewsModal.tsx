import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type News, type NewsFeed } from '../api.ts';
import { ago, fmtWib } from '../format.ts';
import { engineText, locale, tr, useT } from '../i18n.ts';
import { Modal } from './Modal.tsx';

type Props = { pairs: string[]; onClose: () => void; onChanged: () => void };

type ImpactFilter = 'high' | 'medium' | 'all';
const FILTER_KEY = 'dp77-news-filter-v2'; // v2: default changed to every impact

const impactLabel = (impact: string): string => (impact === 'high' ? tr('Merah', 'Red') : impact === 'medium' ? tr('Oranye', 'Orange') : tr('Kuning', 'Yellow'));
const RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
const MIN_RANK: Record<ImpactFilter, number> = { high: 3, medium: 2, all: 1 };

const dayLabel = (d: Date) => new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' }).format(d);
const wibDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(ms));

function loadFilter(): { impact: ImpactFilter; mine: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}');
    return { impact: v.impact === 'high' || v.impact === 'medium' ? v.impact : 'all', mine: v.mine !== false };
  } catch {
    return { impact: 'all', mine: true };
  }
}

// "dalam 45 mnt", "dalam 3 jam", "dalam 2 hari"
function until(ms: number): string {
  const min = Math.round((ms - Date.now()) / 60_000);
  if (min <= 0) return tr('sudah rilis', 'already released');
  if (min < 60) return tr(`dalam ${min} mnt`, `in ${min} min`);
  const h = Math.round(min / 60);
  return h < 48 ? tr(`dalam ${h} jam`, `in ${h} h`) : tr(`dalam ${Math.round(h / 24)} hari`, `in ${Math.round(h / 24)} days`);
}

// The whole calendar ahead (the feed covers the current week), grouped by WIB day.
export function NewsModal({ pairs, onClose, onChanged }: Props) {
  const t = useT();
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
      if (out.at(-1)?.day !== day) out.push({ day, label: day === wibDay(Date.now()) ? tr('Hari ini', 'Today') : dayLabel(new Date(ms)), items: [] });
      out.at(-1)!.items.push(n);
    }
    return out;
  }, [news, filter, mine]);

  return (
    <Modal
      title={t('Berita mendatang', 'Upcoming news')}
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {t(`Sumber ${status?.source ?? '–'}, diambil ${ago(status?.fetchedAt ?? null)}. Kalender hanya mencakup minggu ini.`, `Source ${status?.source ?? '–'}, fetched ${ago(status?.fetchedAt ?? null)}. The calendar only covers this week.`)}
          </span>
          <button type="button" onClick={refresh} disabled={busy}>
            {busy ? t('Memuat…', 'Loading…') : t('Muat ulang', 'Reload')}
          </button>
        </>
      }
    >
      <div className="modal-tools">
        <div className="seg" role="group" aria-label={t('Dampak', 'Impact')}>
          {(['high', 'medium', 'all'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={filter.impact === k} onClick={() => setFilter({ ...filter, impact: k })}>
              {k === 'high' ? t('Merah', 'Red') : k === 'medium' ? t('+ Oranye', '+ Orange') : t('Semua', 'All')}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={filter.mine} onChange={(e) => setFilter({ ...filter, mine: e.target.checked })} />
          {t('Mata uang pair aktif saja', 'Active pair currencies only')}
        </label>
        <span className="muted">{t('Waktu WIB', 'WIB time')}</span>
      </div>
      {error && <p className="error">{error}</p>}
      {status?.error && <p className="error">{t(`Kalender gagal diambil (${status.error}); data terakhir dipakai.`, `Calendar fetch failed (${engineText(status.error)}); last data in use.`)}</p>}
      {!news ? (
        <p className="muted pad">{t('Memuat…', 'Loading…')}</p>
      ) : !days.length ? (
        <p className="muted pad">{t('Tidak ada berita untuk filter ini sampai akhir minggu.', 'No news for this filter until the end of the week.')}</p>
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
                    <span className={`impact impact-${n.impact}`} title={impactLabel(n.impact)} aria-label={t(`dampak ${impactLabel(n.impact)}`, `${impactLabel(n.impact)} impact`)} />
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
