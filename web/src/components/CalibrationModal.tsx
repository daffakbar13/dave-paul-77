import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type CalibrationScore, type LineFit, type LineScore, type ManualOrder, type Side, type SrParams, type SweepResult } from '../api.ts';
import { fmtDate, fmtPrice } from '../format.ts';
import { Modal } from './Modal.tsx';

type Props = { symbols: string[]; onClose: () => void; onChanged: () => void };

const PARAM_LABEL: Partial<Record<keyof SrParams, string>> = {
  fractal: 'Fraktal',
  clusterAtr: 'Penggabungan',
  minTouches: 'Sentuhan',
  strongBodyPct: 'Body/range',
  strongAtr: 'Body/ATR',
  strongPick: 'Candle kuat',
  wickRatio: 'Wick',
  bufferAtr: 'Buffer',
};

const today = () => new Date().toISOString().slice(0, 10);
const atr = (v: number | null) => (v === null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);
const scoreText = (s: CalibrationScore) => `${s.matched} dari ${s.total} cocok · selisih rata-rata ${s.error.toFixed(2)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const lineScoreText = (s: LineScore) => `F1 ${s.f1.toFixed(2)} · presisi ${pct(s.precision)} · recall ${pct(s.recall)} (${s.pairs} pair)`;
const paramText = (k: string, v: unknown) => (k === 'strongPick' ? (v === 'recent' ? 'paling baru' : 'paling dekat') : String(v));

// Lines: the engine's lines vs the user's reference lines. Orders: the user's own orders vs
// the engine on the same day. Both tabs can search parameters and apply them.
export function CalibrationModal({ symbols, onClose, onChanged }: Props) {
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
  const [lineResult, setLineResult] = useState<{ current: LineScore; best: { params: Partial<SrParams>; score: LineScore }[]; tried: number } | null>(null);

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
      setLineResult(null);
      await load();
      onChanged();
      setMessage('Parameter diterapkan. Analisa semua pair dihitung ulang.');
    });

  const num = (k: 'entry' | 'sl' | 'tp') => (
    <input type="number" step="any" inputMode="decimal" required={k !== 'tp'} placeholder={k === 'tp' ? 'opsional' : ''} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
  );

  return (
    <Modal
      title="Kalibrasi"
      onClose={onClose}
      wide
      footer={
        tab === 'orders' && score ? <span className="summary tabular">Parameter sekarang: {scoreText(score)}</span>
          : tab === 'lines' && lines?.score.pairs ? <span className="summary tabular">Garis sekarang: {lineScoreText(lines.score)}</span>
          : undefined
      }
    >
      <div className="seg" role="tablist">
        {([['lines', 'Garis'], ['orders', 'Order']] as const).map(([k, label]) => (
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
            Garis mesin dibandingkan dengan garis Anda (Pengaturan &gt; Pair) di rentang candle yang sama. Satu garis mesin menemukan
            garis Anda jika jaraknya ≤ 0,25 ATR. Presisi = garis mesin yang ada pasangannya; recall = garis Anda yang ditemukan. Garis
            Anda hanya referensi, bukan kebenaran: skor 100% tidak wajib, cek juga hasilnya di Jurnal.
          </p>
          {lines && lines.fits.length > 0 ? (
            <div className="table-scroll">
              <table className="orders tabular">
                <thead>
                  <tr>
                    <th>Pair</th>
                    <th className="num">Garis mesin</th>
                    <th className="num">Garis Anda</th>
                    <th className="num">Cocok</th>
                    <th className="num">Presisi</th>
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
            <p className="muted pad">Belum ada pair dengan garis referensi. Import .tpl di Pengaturan &gt; Pair atau kirim dari EA MT4.</p>
          )}
          <div className="actions sweep-actions">
            <button type="button" className="primary" disabled={!lines?.fits.length || busy !== null} onClick={() => run('lineSweep', async () => setLineResult(await api.lineSweep()))}>
              {busy === 'lineSweep' ? 'Mencari…' : 'Cari parameter garis terbaik'}
            </button>
          </div>
          {lineResult && sr && (
            <section>
              <h3>
                Hasil pencarian <span className="muted tabular">({lineResult.tried} kombinasi; sekarang {lineScoreText(lineResult.current)})</span>
              </h3>
              <div className="table-scroll">
                <table className="orders tabular">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Skor</th>
                      <th>Perubahan dari pengaturan sekarang</th>
                      <th aria-label="Aksi" />
                    </tr>
                  </thead>
                  <tbody>
                    {lineResult.best.map((b, i) => {
                      const changes = Object.entries(b.params).filter(([k, v]) => sr[k as keyof SrParams] !== v);
                      return (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td>{lineScoreText(b.score)}</td>
                          <td>
                            {changes.length
                              ? changes.map(([k, v]) => `${PARAM_LABEL[k as keyof SrParams] ?? k}: ${paramText(k, sr[k as keyof SrParams])} → ${paramText(k, v)}`).join(' · ')
                              : 'Sama dengan sekarang'}
                          </td>
                          <td className="act">
                            <button type="button" disabled={!changes.length || busy !== null} onClick={() => apply(b.params)}>
                              Terapkan
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                Garis berubah, jadi jarak antar garis (g) di model tangga juga berubah. Setelah menerapkan, jalankan tab Order lagi.
              </p>
            </section>
          )}
        </>
      )}

      {tab === 'orders' && (
        <>
          <p className="muted">
            Masukkan order yang Anda pasang manual. Aplikasi menghitung ulang analisa memakai candle sebelum tanggal itu, lalu
            membandingkan entry, SL dan TP otomatis. Selisih dalam satuan ATR D1; cocok jika entry ≤ 0,2 ATR dan SL ≤ 0,3 ATR.
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
              <span>Tipe</span>
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
              <span>Tanggal pasang</span>
              <input type="date" required value={form.asOf} onChange={(e) => setForm({ ...form, asOf: e.target.value })} />
            </label>
            <label className="field note">
              <span>Catatan</span>
              <input value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
            <button type="submit" disabled={busy !== null || !form.symbol}>
              Tambah
            </button>
          </form>

          {orders.length > 0 ? (
            <div className="table-scroll">
              <table className="orders tabular">
                <thead>
                  <tr>
                    <th>Tanggal</th>
                    <th>Pair</th>
                    <th>Tipe</th>
                    <th />
                    <th className="num">Entry</th>
                    <th className="num">SL</th>
                    <th className="num">TP</th>
                    <th>Status</th>
                    <th aria-label="Aksi" />
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
                          {c.match ? 'Cocok' : 'Belum cocok'}
                          {c.reason && <span className="reason">{c.reason}</span>}
                          {c.nearestLine !== null && <span className="reason">Garis terdekat {fmtPrice(c.nearestLine, d)}</span>}
                        </td>
                        <td rowSpan={3} className="act">
                          <button type="button" className="x" aria-label={`Hapus order manual ${o.symbol}`} onClick={() => run('del', async () => { await api.deleteManual(o.id); await load(); })}>
                            ×
                          </button>
                        </td>
                      </tr>
                      <tr>
                        <td className="muted">Otomatis</td>
                        <td className="num">{fmtPrice(c.auto?.entry, d)}</td>
                        <td className="num">{fmtPrice(c.auto?.sl, d)}</td>
                        <td className="num">
                          {fmtPrice(c.auto?.tp, d)}
                          {c.auto?.tpAuto && <span className="tag">TP auto</span>}
                        </td>
                      </tr>
                      <tr className="cal-diff">
                        <td className="muted">Selisih (ATR)</td>
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
            <p className="muted pad">Belum ada order manual.</p>
          )}

          <div className="actions sweep-actions">
            <button type="button" className="primary" disabled={!orders.length || busy !== null} onClick={() => run('sweep', async () => setResult(await api.sweep()))}>
              {busy === 'sweep' ? 'Mencari…' : 'Cari parameter terbaik'}
            </button>
          </div>

          {result && sr && (
            <section>
              <h3>
                Hasil pencarian <span className="muted tabular">({result.tried} kombinasi; sekarang {scoreText(result.current)})</span>
              </h3>
              <div className="table-scroll">
                <table className="orders tabular">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Skor</th>
                      <th>Perubahan dari pengaturan sekarang</th>
                      <th aria-label="Aksi" />
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
                              ? changes.map(([k, v]) => `${PARAM_LABEL[k as keyof SrParams] ?? k}: ${paramText(k, sr[k as keyof SrParams])} → ${paramText(k, v)}`).join(' · ')
                              : 'Sama dengan sekarang'}
                          </td>
                          <td className="act">
                            <button type="button" disabled={!changes.length || busy !== null} onClick={() => apply(b.params)}>
                              Terapkan
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                Dengan sedikit contoh, banyak kombinasi bisa sama-sama cocok. Tambah contoh dari beberapa pair dan tanggal agar hasilnya
                bisa dipercaya.
              </p>
            </section>
          )}
        </>
      )}
    </Modal>
  );
}
