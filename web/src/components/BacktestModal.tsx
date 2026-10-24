import { AreaSeries, ColorType, createChart, PriceScaleMode, type UTCTimestamp } from 'lightweight-charts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type BtGrade, type BtMonthTable, type BtOverall, type BtPair, type BtRun, type BtStreak, type BtTier } from '../api.ts';
import { fmtMoney } from '../format.ts';
import { Modal } from './Modal.tsx';

type Props = { onClose: () => void };
type Tab = 'overall' | 'month' | 'growth' | 'pairs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const GRADE: Record<BtGrade, string> = { good: 'Bagus', ok: 'Cukup', weak: 'Lemah', few: 'Data kurang' };
const TIER: Record<BtTier, string> = { none: 'tanpa data', short: '< 2 th', min: '2 th', good: '5 th', better: '10 th', perfect: '20 th' };

const num = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '–' : v.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '–' : `${num(v, d)}%`);
const sign = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? '' : v > 0 ? 'ok' : 'error');
const fmtYears = (y: number) => (y >= 1 ? `${num(y, 1)} tahun` : `${Math.round(y * 12)} bulan`);

function holding(days: number | null): string {
  if (days === null) return '–';
  const d = Math.floor(days);
  const h = Math.round((days - d) * 24);
  return `${d} hari ${h} jam`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Tile({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className={cls}>
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small className="muted">{sub}</small>}
    </div>
  );
}

function StreakBox({ title, tone, data }: { title: string; tone: 'win' | 'loss'; data: { byTrade: BtStreak; byPips: BtStreak } }) {
  const row = (label: string, s: BtStreak) => (
    <div className="streak-row">
      <span>{label}</span>
      <b>{s.count}×</b>
      <b>
        ({s.pips > 0 ? '+' : ''}
        {num(s.pips, 2)} pips)
      </b>
    </div>
  );
  return (
    <div className={`streak streak-${tone}`}>
      <h3>{title}</h3>
      {row('per trade', data.byTrade)}
      {row('per pips', data.byPips)}
    </div>
  );
}

function OverallView({ o, initial }: { o: BtOverall; initial: number }) {
  return (
    <>
      <div className="tiles tabular">
        <Tile label="Total Profit" value={fmtMoney(o.profit)} sub={pct(o.profitPct)} cls={sign(o.profit)} />
        <Tile label="Avg. Profit / Trade" value={fmtMoney(o.avgProfitTrade)} sub={pct(o.avgProfitTradePct)} cls={sign(o.profit)} />
        <Tile label="Avg. Profit / Bulan" value={fmtMoney(o.avgProfitMonth)} sub={pct(o.avgProfitMonthPct)} cls={sign(o.profit)} />
        <Tile label="Avg. Profit / Tahun" value={fmtMoney(o.avgProfitYear)} sub={pct(o.avgProfitYearPct)} cls={sign(o.profit)} />
        <Tile label="Total Pips" value={num(o.pips)} cls={sign(o.pips)} />
        <Tile label="Avg. Pips / Trade" value={num(o.avgPipsTrade)} cls={sign(o.pips)} />
        <Tile label="Avg. Pips / Bulan" value={num(o.avgPipsMonth)} cls={sign(o.pips)} />
        <Tile label="Avg. Pips / Tahun" value={num(o.avgPipsYear)} cls={sign(o.pips)} />
      </div>
      <div className="tiles big tabular">
        <Tile label="Total Trade" value={`${o.trades}x`} sub={`${o.wins} TP · ${o.losses} SL`} cls="tile-blue" />
        <Tile label="Probability" value={o.probability === null ? '–' : pct(o.probability * 100)} cls="tile-green" />
        <Tile label="Avg. Risk : Reward" value={o.riskReward === null ? '–' : `${num(o.riskReward, 2)}:1`} cls="tile-orange" />
        <Tile label="Avg. Holding Period" value={holding(o.avgHoldDays)} sub="resolusi harian (candle D1)" cls="tile-yellow" />
      </div>
      <div className="streaks">
        <StreakBox title="Consecutive Profit" tone="win" data={o.consecutiveProfit} />
        <StreakBox title="Consecutive Loss" tone="loss" data={o.consecutiveLoss} />
      </div>
      <div className="tiles tabular">
        <Tile label="Profit factor (pips)" value={o.profitFactor === null ? '–' : num(o.profitFactor, 2)} />
        <Tile label="Expectancy" value={o.expectancyR === null ? '–' : `${o.expectancyR >= 0 ? '+' : ''}${num(o.expectancyR, 2)}R`} cls={sign(o.expectancyR)} sub="rata-rata R per trade" />
        <Tile label="Max drawdown" value={fmtMoney(o.maxDrawdown)} sub={pct(o.maxDrawdownPct)} />
        <Tile label="Posisi bersamaan maks" value={String(o.peakOpen)} sub={`≈ ${o.peakOpen}× risiko per trade`} />
        <Tile label="Bergantung urutan intraday" value={String(o.ambiguous)} sub={o.trades ? pct((o.ambiguous / o.trades) * 100, 1) : undefined} />
        <Tile label="Masih terbuka" value={String(o.open)} sub={`balance awal ${fmtMoney(initial)}`} />
      </div>
    </>
  );
}

function MonthView({ pips, money }: { pips: BtMonthTable; money: BtMonthTable }) {
  const [unit, setUnit] = useState<'pips' | 'money'>('pips');
  const t = unit === 'pips' ? pips : money;
  const f = (v: number | null) => (v === null ? '-' : unit === 'pips' ? num(v) : fmtMoney(v));
  return (
    <>
      <div className="modal-tools">
        <span className="seg">
          <button type="button" aria-pressed={unit === 'pips'} onClick={() => setUnit('pips')}>
            Pips
          </button>
          <button type="button" aria-pressed={unit === 'money'} onClick={() => setUnit('money')}>
            Profit
          </button>
        </span>
        <span className="muted">Dihitung pada bulan close trade.</span>
      </div>
      <div className="table-scroll">
        <table className="orders tabular months">
          <thead>
            <tr>
              <th>Tahun</th>
              {MONTHS.map((m) => (
                <th key={m} className="num">
                  {m}
                </th>
              ))}
              <th className="num">YTD</th>
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r) => (
              <tr key={r.year}>
                <th>{r.year}</th>
                {r.months.map((v, i) => (
                  <td key={i} className={`num ${sign(v)}`}>
                    {f(v)}
                  </td>
                ))}
                <td className={`num ${sign(r.ytd)}`}>
                  <b>{f(r.ytd)}</b>
                </td>
              </tr>
            ))}
            <tr>
              <th colSpan={13}>Total</th>
              <td className={`num ${sign(t.total)}`}>
                <b>{f(t.total)}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function GrowthChart({ curve, scope }: { curve: { t: number; balance: number }[]; scope: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [log, setLog] = useState(false);
  // one point per day, ascending
  const data = useMemo(() => {
    const byDay = new Map<number, number>();
    for (const p of curve) byDay.set(Math.floor(p.t / 1000), p.balance);
    return [...byDay].sort((a, b) => a[0] - b[0]).map(([t, value]) => ({ time: t as UTCTimestamp, value }));
  }, [curve]);

  useEffect(() => {
    const chart = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8a929c' },
      grid: { vertLines: { visible: false }, horzLines: { color: '#2a2f36' } },
      rightPriceScale: { borderVisible: false, mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal },
      timeScale: { borderVisible: false },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#3bd16f',
      topColor: 'rgba(59, 209, 111, 0.35)',
      bottomColor: 'rgba(59, 209, 111, 0.02)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    series.setData(data);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, log]);

  return (
    <>
      <div className="modal-tools">
        <span className="muted">{scope === 'ALL' ? 'Equity dari balance awal, dihitung saat trade close.' : `Balance awal + kontribusi ${scope} saja.`}</span>
        <label className="inline">
          <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} /> Skala log
        </label>
      </div>
      <div ref={box} className="growth-chart" role="img" aria-label="Grafik pertumbuhan equity" />
    </>
  );
}

type SortKey = 'symbol' | 'trades' | 'winRate' | 'profitFactor' | 'expectancyR' | 'pips' | 'profit' | 'maxDrawdownR' | 'maxLossStreak' | 'perYear';

function PairsView({ pairs, onPick }: { pairs: BtPair[]; onPick: (symbol: string) => void }) {
  const [key, setKey] = useState<SortKey>('expectancyR');
  const [desc, setDesc] = useState(true);
  const rows = useMemo(() => {
    const v = (p: BtPair) => (p[key] ?? (desc ? -Infinity : Infinity)) as number | string;
    return [...pairs].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
      return desc ? -c : c;
    });
  }, [pairs, key, desc]);
  const th = (k: SortKey, label: string, numeric = true) => (
    <th className={numeric ? 'num' : ''} aria-sort={key === k ? (desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        className="sort"
        onClick={() => {
          if (key === k) setDesc(!desc);
          else {
            setKey(k);
            setDesc(k !== 'symbol');
          }
        }}
      >
        {label}
        {key === k ? (desc ? ' ▼' : ' ▲') : ''}
      </button>
    </th>
  );
  return (
    <>
      <p className="muted">
        Kualitas tiap pair dari hasil run yang sama. Nilai: Bagus = expectancy ≥ 0,15R dan profit factor ≥ 1,3; Cukup = positif; Lemah = rugi; di bawah 30 trade tidak dinilai. Klik pair untuk lihat ringkasannya.
      </p>
      <div className="table-scroll">
        <table className="orders tabular">
          <thead>
            <tr>
              {th('symbol', 'Pair', false)}
              <th>Nilai</th>
              {th('trades', 'Trade')}
              {th('winRate', 'Win')}
              {th('profitFactor', 'PF')}
              {th('expectancyR', 'Expectancy')}
              {th('pips', 'Pips')}
              {th('profit', 'Profit')}
              {th('maxDrawdownR', 'DD (R)')}
              {th('maxLossStreak', 'Kalah beruntun')}
              {th('perYear', 'Trade/th')}
              <th className="num">Data</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.symbol} className="clickable" onClick={() => onPick(p.symbol)}>
                <td>
                  <b>{p.symbol}</b>
                </td>
                <td>
                  <span className={`grade grade-${p.grade}`}>{GRADE[p.grade]}</span>
                </td>
                <td className="num">{p.trades}</td>
                <td className="num">{p.winRate === null ? '–' : pct(p.winRate * 100, 0)}</td>
                <td className="num">{p.profitFactor === null ? '–' : num(p.profitFactor, 2)}</td>
                <td className={`num ${sign(p.expectancyR)}`}>{p.expectancyR === null ? '–' : `${p.expectancyR >= 0 ? '+' : ''}${num(p.expectancyR, 2)}R`}</td>
                <td className={`num ${sign(p.pips)}`}>{num(p.pips)}</td>
                <td className={`num ${sign(p.profit)}`}>{fmtMoney(p.profit)}</td>
                <td className="num">{num(p.maxDrawdownR, 1)}</td>
                <td className="num">{p.maxLossStreak}</td>
                <td className="num">{p.perYear === null ? '–' : num(p.perYear, 0)}</td>
                <td className="num">
                  {fmtYears(p.years)} <span className="muted">({TIER[p.tier]})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function BacktestModal({ onClose }: Props) {
  const [balance, setBalance] = useState('6000');
  const [risk, setRisk] = useState('1');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [symbol, setSymbol] = useState('ALL');
  const [data, setData] = useState<BtRun | null>(null);
  const [tab, setTab] = useState<Tab>('overall');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      setData(await api.backtest(runId, symbol === 'ALL' ? undefined : symbol));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runId, symbol]);

  useEffect(() => {
    void load();
  }, [load]);

  // poll while the server is still replaying
  useEffect(() => {
    if (data?.status !== 'running') return;
    const id = setInterval(() => void load(), 1000);
    return () => clearInterval(id);
  }, [data?.status, load]);

  const start = async () => {
    const b = Number(balance);
    const r = Number(risk);
    if (!(b > 0) || !(r > 0)) {
      setError('Balance dan risk harus lebih dari 0');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.runBacktest({ balance: b, riskPct: r, ...(from ? { from } : {}), ...(to ? { to } : {}) });
      setData(null);
      setSymbol('ALL');
      setRunId(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (detail: boolean) => {
    if (!runId) return;
    try {
      download(await api.backtestCsv(runId, symbol === 'ALL' ? undefined : symbol, detail), `backtest-${symbol === 'ALL' ? 'semua-pair' : symbol}${detail ? '-detail' : ''}.csv`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const done = data?.status === 'done' && data.overall;
  const cov = data?.coverage ?? [];
  const minYears = cov.length ? Math.min(...cov.map((c) => c.years)) : 0;
  const shortPairs = cov.filter((c) => c.tier === 'short' || c.tier === 'none');
  const tabs: [Tab, string][] = [['overall', 'Overall'], ['month', 'Per Month'], ['growth', 'Growth'], ['pairs', 'Pair']];

  return (
    <Modal title="Backtest" onClose={onClose} wide>
      <div className="modal-tools">
        <label className="inline">
          Balance <input type="number" min="1" step="any" value={balance} onChange={(e) => setBalance(e.target.value)} className="short" />
        </label>
        <label className="inline">
          Risk / trade % <input type="number" min="0.01" step="any" value={risk} onChange={(e) => setRisk(e.target.value)} className="short" />
        </label>
        <label className="inline">
          Dari <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          Sampai <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="primary" disabled={busy || data?.status === 'running'} onClick={() => void start()}>
          {data?.status === 'running' ? 'Memproses…' : 'Jalankan'}
        </button>
      </div>
      <p className="muted">
        Compounding: tiap trade berisiko {risk || '…'}% dari balance saat fill (hanya trade yang sudah close sebelum hari itu). Semua pair aktif, satu balance. Memakai pengaturan S/R yang tersimpan.
      </p>
      {error && <p className="error">{error}</p>}
      {data?.status === 'running' && (
        <p className="muted" role="status">
          Memproses pair {data.progress.done}/{data.progress.total}…
        </p>
      )}
      {data?.status === 'error' && <p className="error">{data.error}</p>}

      {done && data.overall && (
        <>
          {(minYears < 2 || shortPairs.length > 0) && (
            <p className="banner-warn">
              Data teruji hanya {fmtYears(minYears)}
              {shortPairs.length === cov.length ? ' di semua pair' : ` di ${shortPairs.map((c) => c.symbol).join(', ')}`}. Minimum 2 tahun; 5 / 10 / 20 tahun lebih meyakinkan. Tambah riwayat candle D1 (backfill) dulu sebelum mengandalkan angka ini.
            </p>
          )}
          <div className="modal-tools">
            <label className="inline">
              Pair{' '}
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Pair">
                <option value="ALL">Semua pair</option>
                {(data.pairs ?? []).map((p) => (
                  <option key={p.symbol} value={p.symbol}>
                    {p.symbol}
                  </option>
                ))}
              </select>
            </label>
            <span className="tabs-inline" role="tablist">
              {tabs.map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                  {label}
                </button>
              ))}
            </span>
            <button type="button" onClick={() => void save(false)} disabled={!data.overall.trades && !data.overall.open}>
              Unduh CSV
            </button>
            <button type="button" onClick={() => void save(true)} disabled={!data.overall.trades && !data.overall.open}>
              CSV detail
            </button>
          </div>
          {symbol !== 'ALL' && <p className="muted">Hanya {symbol}. Profit = bagian pair ini dari run bersama.</p>}

          {tab === 'overall' && <OverallView o={data.overall} initial={data.input.balance} />}
          {tab === 'month' && data.monthsPips && data.monthsMoney && <MonthView pips={data.monthsPips} money={data.monthsMoney} />}
          {tab === 'growth' && data.curve && <GrowthChart curve={data.curve} scope={symbol} />}
          {tab === 'pairs' && data.pairs && (
            <PairsView
              pairs={data.pairs}
              onPick={(s) => {
                setSymbol(s);
                setTab('overall');
              }}
            />
          )}

          <p className="muted foot-note">
            Candle D1: untuk trade yang entry dan exit-nya satu hari, urutan harga dibaca open-low-high-close (candle naik) atau open-high-low-close (candle turun). {data.overall.ambiguous} dari {data.overall.trades} trade
            ({data.overall.trades ? pct((data.overall.ambiguous / data.overall.trades) * 100, 1) : '–'}) hasilnya berubah bila urutannya terbalik. Jika SL dan TP kena di candle yang sama setelah posisi terbuka, SL dihitung dulu. Spread, komisi, dan slippage tidak dihitung, jadi hasil lebih optimis dari akun nyata. Warm-up {data.warmup} candle.
          </p>
        </>
      )}
    </Modal>
  );
}
