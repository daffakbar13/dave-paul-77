import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Account, type News } from '../api.ts';
import { ago, digitsOf, fmtNewsTime, fmtPrice, fmtRr } from '../format.ts';
import { engineText, tr, useT } from '../i18n.ts';
import { nearestSignals, type SignalRow } from '../tf.ts';
import { Modal } from './Modal.tsx';

type Props = {
  account: Account | null;
  news: News[]; // red news in the server's news window
  onClose: () => void;
};

// Signals the analyst has already typed into the TF mobile app. Marks live on the server
// so every device shows the same, and reset at 05:00 WIB. The key holds the prices, so a
// level that moves comes back unmarked.
const doneKey = (s: SignalRow) => `${s.symbol}|${s.side}|${s.entry}|${s.sl}|${s.tp}`;

// The next 05:00 WIB (22:00 UTC): the TF day the signals belong to ends there, as do the marks.
const DAY = 24 * 3_600_000;
const RESET_UTC = 22 * 3_600_000;
const nextReset = (now: number) => Math.floor((now - RESET_UTC) / DAY) * DAY + RESET_UTC + DAY;

const typeLabel = (s: SignalRow) => `${s.type}${s.running ? tr(' (berjalan)', ' (running)') : ''}`;

// Nearest buy stop and sell stop per pair among the orders the EA holds (sent by the last
// Execute, plus open positions), to copy by hand into the TF mobile app.
// Up/Down moves the selection, Space marks the selected signal as created.
export function SignalsModal({ account, news, onClose }: Props) {
  const t = useT();
  const [signals, setSignals] = useState<SignalRow[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const load = useCallback(async () => {
    if (!account) return;
    try {
      const [r, m] = await Promise.all([api.tfSignals(account.id), api.tfMarks()]);
      setSignals(nearestSignals(r.rows));
      setSentAt(r.sentAt);
      setDone(new Set(m.keys));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [account]);

  useEffect(() => {
    void load();
  }, [load]);

  // optimistic; a failed save puts the mark back
  const setMark = (k: string, on: boolean) =>
    setDone((cur) => {
      const copy = new Set(cur);
      if (on) copy.add(k);
      else copy.delete(k);
      return copy;
    });
  const toggleDone = useCallback(
    (s: SignalRow) => {
      const k = doneKey(s);
      const next = !done.has(k);
      setMark(k, next);
      api.setTfMark(k, next).catch((e: Error) => {
        setError(e.message);
        setMark(k, !next);
      });
    },
    [done],
  );

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

  // red news per pair still ahead and before the next 05:00 WIB: the badge and its tooltip.
  // News after that belongs to the next TF day, so it does not flag today's signals.
  const newsFor = useMemo(() => {
    const now = Date.now();
    const end = nextReset(now);
    const red = news.filter((n) => {
      const at = Date.parse(n.at);
      return n.impact === 'high' && at >= now && at < end;
    });
    return (symbol: string) => red.filter((n) => symbol.includes(n.currency)).map((n) => `${n.currency} ${fmtNewsTime(n.at)}: ${n.title}`).join('\n');
  }, [news]);

  const doneCount = signals?.filter((s) => done.has(doneKey(s))).length ?? 0;
  const hint = t('↑/↓ pilih baris · Spasi tandai sudah dibuat · tanda direset 05:00 WIB', '↑/↓ select a row · Space marks it created · marks reset at 05:00 WIB');
  const sent = sentAt ? t(`Order dari Execute terakhir (${ago(sentAt)})`, `Orders from the last Execute (${ago(sentAt)})`) : '';

  return (
    <Modal title={t('Sinyal TF', 'TF signals')} onClose={onClose} wide footer={signals ? <span className="muted">{t(`${doneCount} dari ${count} sudah dibuat`, `${doneCount} of ${count} created`)} · {sent && <>{sent} · </>}{hint}</span> : undefined}>
      {error && <p className="error">{error}</p>}
      {!account && <p className="muted pad">{t('Tambahkan akun MT5 di Pengaturan dulu.', 'Add an MT5 account in Settings first.')}</p>}
      <div className="sig-split">
      {current && <SignalDetail s={current} news={newsFor(current.symbol)} done={!!done.has(doneKey(current))} onToggle={() => toggleDone(current)} />}
      {signals && !signals.length && (
        <p className="muted pad">{t('Belum ada order yang dipasang EA di akun ini. Jalankan Execute dulu.', 'The EA holds no orders on this account yet. Run Execute first.')}</p>
      )}
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
                const isDone = !!done.has(doneKey(s));
                const cls = [i === selected ? 'sig-selected' : '', isDone ? 'sig-done' : '', s.running ? 'sig-running' : ''].join(' ');
                return (
                  <tr key={s.id} className={cls} aria-selected={i === selected} onClick={() => setSelected(i)}>
                    <td>
                      {s.symbol}
                      {newsFor(s.symbol) && (
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
