import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Account, type AggressiveMode, type News } from '../api.ts';
import { digitsOf, fmtNewsTime, fmtPrice, fmtRr } from '../format.ts';
import { engineText, tr, useT } from '../i18n.ts';
import { nearestSignals, type SignalRow } from '../tf.ts';
import { Modal } from './Modal.tsx';

type Props = {
  account: Account | null;
  aggressive: AggressiveMode;
  newsPairs: Set<string>; // pairs with red news ahead in the news window
  news: News[];
  onClose: () => void;
};

// Signals the analyst has already typed into the TF mobile app, per browser. The key
// holds the prices, so a level that moves comes back unmarked. Marks older than a week
// are dropped.
const DONE_KEY = 'dp77-tf-done';
const WEEK = 7 * 24 * 3600_000;
const doneKey = (s: SignalRow) => `${s.symbol}|${s.side}|${s.entry}|${s.sl}|${s.tp}`;

function loadDone(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}') as Record<string, number>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(v).filter(([, at]) => typeof at === 'number' && now - at < WEEK));
  } catch {
    return {};
  }
}

function saveDone(v: Record<string, number>) {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(v));
  } catch {
    // per-viewer convenience only
  }
}

const typeLabel = (s: SignalRow) => `${s.type}${s.running ? tr(' (berjalan)', ' (running)') : ''}`;

// Nearest buy stop and sell stop per pair, to copy by hand into the TF mobile app.
// Up/Down moves the selection, Space marks the selected signal as created.
export function SignalsModal({ account, aggressive, newsPairs, news, onClose }: Props) {
  const t = useT();
  const [signals, setSignals] = useState<SignalRow[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [done, setDoneState] = useState(loadDone);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const load = useCallback(async () => {
    if (!account) return;
    try {
      const r = await api.orders(account.id, aggressive);
      setSignals(nearestSignals(r.rows));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [account, aggressive]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleDone = useCallback((s: SignalRow) => {
    setDoneState((cur) => {
      const k = doneKey(s);
      const next = { ...cur };
      if (next[k]) delete next[k];
      else next[k] = Date.now();
      saveDone(next);
      return next;
    });
  }, []);

  const count = signals?.length ?? 0;
  const current = signals?.[Math.min(selected, count - 1)] ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !count) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(0, Math.min(count - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === ' ' && current) {
        e.preventDefault();
        toggleDone(current);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [count, current, toggleDone]);

  useEffect(() => {
    bodyRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected, signals]);

  // red news per pair, for the badge tooltip
  const newsFor = useMemo(() => {
    const red = news.filter((n) => n.impact === 'high');
    return (symbol: string) => red.filter((n) => symbol.includes(n.currency)).map((n) => `${n.currency} ${fmtNewsTime(n.at)}: ${n.title}`).join('\n');
  }, [news]);

  const doneCount = signals?.filter((s) => done[doneKey(s)]).length ?? 0;
  const hint = t('↑/↓ pilih baris · Spasi tandai sudah dibuat', '↑/↓ select a row · Space marks it created');

  return (
    <Modal title={t('Sinyal TF', 'TF signals')} onClose={onClose} wide footer={signals ? <span className="muted">{t(`${doneCount} dari ${count} sudah dibuat`, `${doneCount} of ${count} created`)} · {hint}</span> : undefined}>
      {error && <p className="error">{error}</p>}
      {!account && <p className="muted pad">{t('Tambahkan akun MT5 di Pengaturan dulu.', 'Add an MT5 account in Settings first.')}</p>}
      <div className="sig-split">
      {current && <SignalDetail s={current} news={newsPairs.has(current.symbol) ? newsFor(current.symbol) : ''} done={!!done[doneKey(current)]} onToggle={() => toggleDone(current)} />}
      {signals && !signals.length && <p className="muted pad">{t('Belum ada buy/sell stop yang valid.', 'No valid buy/sell stops yet.')}</p>}
      {signals && signals.length > 0 && (
        <div className="table-scroll">
          <table className="orders tabular signals">
            <thead>
              <tr>
                <th>Pair</th>
                <th>{t('Tipe', 'Type')}</th>
                <th className="num">Entry</th>
                <th className="num">SL</th>
                <th className="num">TP</th>
                <th className="num">SL pips</th>
                <th className="num">TP pips</th>
                <th className="num">RR</th>
                <th className="num">VP</th>
                <th>{t('Aturan TF', 'TF rules')}</th>
                <th>{t('Dibuat', 'Created')}</th>
              </tr>
            </thead>
            <tbody ref={bodyRef}>
              {signals.map((s, i) => {
                const d = digitsOf(s.symbol);
                const isDone = !!done[doneKey(s)];
                const cls = [i === selected ? 'sig-selected' : '', isDone ? 'sig-done' : '', s.running ? 'sig-running' : ''].join(' ');
                return (
                  <tr key={s.id} className={cls} aria-selected={i === selected} onClick={() => setSelected(i)}>
                    <td>
                      {s.symbol}
                      {newsPairs.has(s.symbol) && (
                        <span className="tag news-badge" title={newsFor(s.symbol)}>
                          Red news
                        </span>
                      )}
                    </td>
                    <td>{typeLabel(s)}</td>
                    <td className="num">{fmtPrice(s.entry, d)}</td>
                    <td className="num">{fmtPrice(s.sl, d)}</td>
                    <td className="num">{fmtPrice(s.tp, d)}</td>
                    <td className="num">{s.slPips}</td>
                    <td className="num">{s.tpPips}</td>
                    <td className="num">{fmtRr(s.rr)}</td>
                    <td className="num">{s.vp ?? '–'}</td>
                    <td className={s.problems.length ? 'sig-bad' : 'sig-ok'}>{s.problems.length ? s.problems.join(' · ') : 'OK'}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={isDone}
                        aria-label={t(`Tandai ${s.symbol} ${s.type} sudah dibuat`, `Mark ${s.symbol} ${s.type} created`)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => {
                          setSelected(i);
                          toggleDone(s);
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </Modal>
  );
}

// The selected signal in large type, to read off while typing it into the phone.
function SignalDetail({ s, news, done, onToggle }: { s: SignalRow; news: string; done: boolean; onToggle: () => void }) {
  const t = useT();
  const d = digitsOf(s.symbol);
  return (
    <section className={`sig-detail${done ? ' sig-done' : ''}`} aria-live="polite">
      <div className="sig-head">
        <strong>{s.symbol}</strong>
        <span className={s.side === 'buy' ? 'sig-buy' : 'sig-sell'}>{typeLabel(s)}</span>
        {news && (
          <span className="tag news-badge" title={news}>
            Red news
          </span>
        )}
        <button type="button" className={done ? 'primary' : ''} onClick={onToggle}>
          {done ? t('✓ Sudah dibuat', '✓ Created') : t('Tandai sudah dibuat', 'Mark created')}
        </button>
      </div>
      <dl className="sig-prices tabular">
        <div>
          <dt>Entry</dt>
          <dd>{fmtPrice(s.entry, d)}</dd>
        </div>
        <div>
          <dt>SL</dt>
          <dd>{fmtPrice(s.sl, d)}</dd>
          <small>{s.slPips} pips</small>
        </div>
        <div>
          <dt>TP</dt>
          <dd>{fmtPrice(s.tp, d)}</dd>
          <small>{s.tpPips} pips</small>
        </div>
        <div>
          <dt>RR · VP</dt>
          <dd>
            {fmtRr(s.rr)} · {s.vp ?? '–'}
          </dd>
        </div>
      </dl>
      {s.problems.length > 0 && <p className="sig-bad">{s.problems.join(' · ')}</p>}
      {s.running && s.reason && <p className="muted">{engineText(s.reason)}</p>}
      {news && <p className="sig-news">{news.split('\n').join(' · ')}</p>}
    </section>
  );
}
