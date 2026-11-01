import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type CalibrationScore, type LineFit, type LineScore, type ManualOrder, type Side, type SrParams, type SweepResult } from '../api.ts';
import { fmtDate, fmtPrice } from '../format.ts';
import { tr, useT } from '../i18n.ts';
import { Modal } from './Modal.tsx';

type Props = { symbols: string[]; onClose: () => void; onChanged: () => void };

const paramLabel = (k: string): string | undefined => {
  const m: Partial<Record<keyof SrParams, string>> = {
    entryGap: 'Entry gap',
    slGap: 'SL gap',
    tpGap: 'TP gap',
  };
  return m[k as keyof SrParams];
};

const today = () => new Date().toISOString().slice(0, 10);
const atr = (v: number | null) => (v === null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);
const scoreText = (s: CalibrationScore) => tr(`${s.matched} dari ${s.total} cocok · selisih rata-rata ${s.error.toFixed(2)}`, `${s.matched} of ${s.total} matched · average difference ${s.error.toFixed(2)}`);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const lineScoreText = (s: LineScore) => tr(`F1 ${s.f1.toFixed(2)} · presisi ${pct(s.precision)} · recall ${pct(s.recall)} (${s.pairs} pair)`, `F1 ${s.f1.toFixed(2)} · precision ${pct(s.precision)} · recall ${pct(s.recall)} (${s.pairs} pairs)`);

// Lines: the engine's lines vs the user's reference lines. Orders: the user's own orders vs
// the engine on the same day. Both tabs can search parameters and apply them.
export function CalibrationModal({ symbols, onClose, onChanged }: Props) {
  const t = useT();
  const [orders, setOrders] = useState<ManualOrder[]>([]);
  const [score, setScore] = useState<CalibrationScore | null>(null);
  const [sr, setSr] = useState<SrParams | null>(null);
  const [form, setForm] = useState({ symbol: symbols[0] ?? '', side: 'buy' as Side, entry: '', sl: '', tp: '', asOf: today(), note: '' });
  const [result, setResult] = useState<SweepResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'lines' | 'orders'>('lines');
  const [lines, setLines] = useState<{ fits: LineFit[]; score: LineScore } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.calibration();
      setOrders(r.orders);
      setScore(r.score);
      setSr(r.sr);
      const l = await api.lineFit();
      setLines({ fits: l.fits, score: l.score });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run('add', async () => {
      await api.addManual({
        symbol: form.symbol,
        side: form.side,
        entry: Number(form.entry),
        sl: Number(form.sl),
        tp: form.tp ? Number(form.tp) : null,
        asOf: form.asOf,
        note: form.note,
      });
      setForm({ ...form, entry: '', sl: '', tp: '', note: '' });
      setResult(null);
      await load();
    });
  };

  const apply = (params: Partial<SrParams>) =>
    run('apply', async () => {
      await api.saveSettings({ sr: { ...sr!, ...params } });
      setResult(null);
      await load();
      onChanged();
      setMessage(t('Parameter diterapkan. Analisa semua pair dihitung ulang.', 'Parameters applied. All pairs are being re-analysed.'));
    });

  const num = (k: 'entry' | 'sl' | 'tp') => (
    <input type="number" step="any" inputMode="decimal" required={k !== 'tp'} placeholder={k === 'tp' ? t('opsional', 'optional') : ''} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
  );

  return (
    <Modal
      title={t('Kalibrasi', 'Calibration')}
      onClose={onClose}
      wide
      footer={
        tab === 'orders' && score ? <span className="summary tabular">{t('Parameter sekarang', 'Current parameters')}: {scoreText(score)}</span>
          : tab === 'lines' && lines?.score.pairs ? <span className="summary tabular">{t('Garis sekarang', 'Current lines')}: {lineScoreText(lines.score)}</span>
          : undefined
      }
    >
      <div className="seg" role="tablist">
        {([['lines', t('Garis', 'Lines')], ['orders', 'Order']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}

      {tab === 'lines' && (
        <>
          <p className="muted">
            {t(
              'Garis mesin dibandingkan dengan garis Anda (Pengaturan > Pair) di rentang candle yang sama. Satu garis mesin menemukan garis Anda jika jaraknya ≤ 0,25 ATR. Presisi = garis mesin yang ada pasangannya; recall = garis Anda yang ditemukan. Garis Anda hanya referensi, bukan kebenaran: skor 100% tidak wajib, cek juga hasilnya di Jurnal.',
              'Engine lines are compared with your lines (Settings > Pair) over the same candle range. An engine line finds your line if it is within 0.25 ATR. Precision = engine lines that have a match; recall = your lines that were found. Your lines are only a reference, not the truth: a 100% score is not required, also check the results in the Journal.',
            )}
          </p>
          {lines && lines.fits.length > 0 ? (
            <div className="table-scroll">
              <table className="orders tabular">
                <thead>
                  <tr>
                    <th>Pair</th>
                    <th className="num">{t('Garis mesin', 'Engine lines')}</th>
                    <th className="num">{t('Garis Anda', 'Your lines')}</th>
                    <th className="num">{t('Cocok', 'Matched')}</th>
                    <th className="num">{t('Presisi', 'Precision')}</th>
                    <th className="num">Recall</th>
                    <th className="num">F1</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.fits.map((f) => (
                    <tr key={f.symbol}>
                      <td>{f.symbol}</td>
                      <td className="num">{f.engine}</td>
                      <td className="num">{f.reference}</td>
                      <td className="num">{f.matched}</td>
                      <td className="num">{pct(f.precision)}</td>
                      <td className="num">{pct(f.recall)}</td>
                      <td className="num">{f.f1.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted pad">{t('Belum ada pair dengan garis referensi. Import .tpl di Pengaturan > Pair atau kirim dari EA MT4.', 'No pair has reference lines yet. Import a .tpl in Settings > Pair or send from the MT4 EA.')}</p>
          )}
        </>
      )}

      {tab === 'orders' && (
        <>
          <p className="muted">
            {t(
              'Masukkan order yang Anda pasang manual. Aplikasi menghitung ulang analisa memakai candle sebelum tanggal itu, lalu membandingkan entry, SL dan TP otomatis. Selisih dalam satuan ATR D1; cocok jika entry ≤ 0,2 ATR dan SL ≤ 0,3 ATR.',
              'Enter the orders you placed manually. The app re-runs the analysis using candles before that date, then compares the automatic entry, SL and TP. Differences are in D1 ATR units; a match means entry ≤ 0.2 ATR and SL ≤ 0.3 ATR.',
            )}
          </p>
          <form className="manual-form" onSubmit={add}>
            <label className="field">
              <span>Pair</span>
              <select value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}>
                {symbols.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('Tipe', 'Type')}</span>
              <select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value as Side })}>
                <option value="buy">buy stop</option>
                <option value="sell">sell stop</option>
              </select>
            </label>
            <label className="field">
              <span>Entry</span>
              {num('entry')}
            </label>
            <label className="field">
              <span>SL</span>
              {num('sl')}
            </label>
            <label className="field">
              <span>TP</span>
              {num('tp')}
            </label>
            <label className="field">
              <span>{t('Tanggal pasang', 'Placed on')}</span>
              <input type="date" required value={form.asOf} onChange={(e) => setForm({ ...form, asOf: e.target.value })} />
            </label>
            <label className="field note">
              <span>{t('Catatan', 'Note')}</span>
              <input value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
            <button type="submit" disabled={busy !== null || !form.symbol}>
              {t('Tambah', 'Add')}
            </button>
          </form>

          {orders.length > 0 ? (
            <div className="table-scroll">
              <table className="orders tabular">
                <thead>
                  <tr>
                    <th>{t('Tanggal', 'Date')}</th>
                    <th>Pair</th>
                    <th>{t('Tipe', 'Type')}</th>
                    <th />
                    <th className="num">Entry</th>
                    <th className="num">SL</th>
                    <th className="num">TP</th>
                    <th>Status</th>
                    <th aria-label={t('Aksi', 'Actions')} />
                  </tr>
                </thead>
                {orders.map((o) => {
                  const c = o.comparison;
                  const d = o.digits;
                  return (
                    <tbody key={o.id} className={c.match ? 'cal-match' : 'cal-miss'}>
                      <tr>
                        <td rowSpan={3}>
                          {fmtDate(o.asOf)}
                          {o.note && <span className="reason">{o.note}</span>}
                        </td>
                        <td rowSpan={3}>{o.symbol}</td>
                        <td rowSpan={3}>{o.side} stop</td>
                        <td className="muted">Manual</td>
                        <td className="num">{fmtPrice(o.entry, d)}</td>
                        <td className="num">{fmtPrice(o.sl, d)}</td>
                        <td className="num">{fmtPrice(o.tp, d)}</td>
                        <td rowSpan={3} className="status">
                          {c.match ? t('Cocok', 'Matched') : t('Belum cocok', 'Not matched')}
                          {c.reason && <span className="reason">{c.reason}</span>}
                          {c.nearestLine !== null && <span className="reason">{t('Garis terdekat', 'Nearest line')} {fmtPrice(c.nearestLine, d)}</span>}
                        </td>
                        <td rowSpan={3} className="act">
                          <button type="button" className="x" aria-label={t(`Hapus order manual ${o.symbol}`, `Delete manual order ${o.symbol}`)} onClick={() => run('del', async () => { await api.deleteManual(o.id); await load(); })}>
                            ×
                          </button>
                        </td>
                      </tr>
                      <tr>
                        <td className="muted">{t('Otomatis', 'Automatic')}</td>
                        <td className="num">{fmtPrice(c.auto?.entry, d)}</td>
                        <td className="num">{fmtPrice(c.auto?.sl, d)}</td>
                        <td className="num">
                          {fmtPrice(c.auto?.tp, d)}
                          {c.auto?.tpAuto && <span className="tag">TP auto</span>}
                        </td>
                      </tr>
                      <tr className="cal-diff">
                        <td className="muted">{t('Selisih (ATR)', 'Difference (ATR)')}</td>
                        <td className="num">{atr(c.dEntry)}</td>
                        <td className="num">{atr(c.dSl)}</td>
                        <td className="num">{atr(c.dTp)}</td>
                      </tr>
                    </tbody>
                  );
                })}
              </table>
            </div>
          ) : (
            <p className="muted pad">{t('Belum ada order manual.', 'No manual orders yet.')}</p>
          )}

          <div className="actions sweep-actions">
            <button type="button" className="primary" disabled={!orders.length || busy !== null} onClick={() => run('sweep', async () => setResult(await api.sweep()))}>
              {busy === 'sweep' ? t('Mencari…', 'Searching…') : t('Cari parameter terbaik', 'Find the best parameters')}
            </button>
          </div>

          {result && sr && (
            <section>
              <h3>
                {t('Hasil pencarian', 'Search results')} <span className="muted tabular">({result.tried} {t('kombinasi', 'combinations')}; {t('sekarang', 'current')} {scoreText(result.current)})</span>
              </h3>
              <div className="table-scroll">
                <table className="orders tabular">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('Skor', 'Score')}</th>
                      <th>{t('Perubahan dari pengaturan sekarang', 'Changes from current settings')}</th>
                      <th aria-label={t('Aksi', 'Actions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {result.best.map((b, i) => {
                      const changes = Object.entries(b.params).filter(([k, v]) => sr[k as keyof SrParams] !== v);
                      return (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td>{scoreText(b.score)}</td>
                          <td>
                            {changes.length
                              ? changes.map(([k, v]) => `${paramLabel(k) ?? k}: ${String(sr[k as keyof SrParams])} → ${String(v)}`).join(' · ')
                              : t('Sama dengan sekarang', 'Same as current')}
                          </td>
                          <td className="act">
                            <button type="button" disabled={!changes.length || busy !== null} onClick={() => apply(b.params)}>
                              {t('Terapkan', 'Apply')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                {t(
                  'Dengan sedikit contoh, banyak kombinasi bisa sama-sama cocok. Tambah contoh dari beberapa pair dan tanggal agar hasilnya bisa dipercaya.',
                  'With few examples, many combinations can match equally well. Add examples from several pairs and dates so the result can be trusted.',
                )}
              </p>
            </section>
          )}
        </>
      )}
    </Modal>
  );
}
