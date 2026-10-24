import { AreaSeries, ColorType, createChart, PriceScaleMode, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { WorkerIn, WorkerOut } from '../backtest.worker.ts';
import { withoutPairs, type BacktestRun, type Coverage } from '../engine/backtest.ts';
import { equityCurve, monthTable, overall, pairStats, thin, tradesCsv, type MonthTable, type Overall, type PairGrade, type PairStats, type Streak } from '../engine/backtestStats.ts';
import { fmtMoney } from '../format.ts';
import { Modal } from './Modal.tsx';

type Props = { onClose: () => void };
type PairRow = PairStats & { tier: Coverage['tier']; years: number; gapDays: number; active: boolean };
type Tab = 'overall' | 'month' | 'growth' | 'pairs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const GRADE: Record<PairGrade, string> = { good: 'Bagus', ok: 'Cukup', weak: 'Lemah', few: 'Data kurang' };
const TIER: Record<Coverage['tier'], string> = { none: 'tanpa data', short: '< 2 th', min: '2 th', good: '5 th', better: '10 th', perfect: '20 th' };

const num = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '–' : v.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '–' : `${num(v, d)}%`);
const sign = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? '' : v > 0 ? 'ok' : 'error');
const fmtYears = (y: number) => (y >= 1 ? `${num(y, 1)} tahun` : `${Math.round(y * 12)} bulan`);

const EXCLUDED_KEY = 'dp77.backtest.excluded';
type SavedExcluded = { all: string; excluded: string[] };
function readExcluded(): SavedExcluded {
  try {
    const v = JSON.parse(localStorage.getItem(EXCLUDED_KEY) ?? 'null') as SavedExcluded | null;
    if (v && typeof v.all === 'string' && Array.isArray(v.excluded)) return v;
  } catch {
    /* storage blocked or corrupt: start with every pair */
  }
  return { all: '', excluded: [] };
}
function writeExcluded(v: SavedExcluded) {
  try {
    localStorage.setItem(EXCLUDED_KEY, JSON.stringify(v));
  } catch {
    /* the choice just does not survive a reload */
  }
}

const WORST_COUNT = 4;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const lastYears = (n: number): [string, string] => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return [ymd(d), ''];
};
const RANGES: { label: string; range: () => [string, string] }[] = [
  { label: 'Semua data', range: () => ['', ''] },
  { label: '1 th terakhir', range: () => lastYears(1) },
  { label: '3 th', range: () => lastYears(3) },
  { label: '5 th', range: () => lastYears(5) },
  { label: '10 th', range: () => lastYears(10) },
  { label: '2010–14', range: () => ['2010-01-01', '2014-12-31'] },
  { label: '2015–19', range: () => ['2015-01-01', '2019-12-31'] },
  { label: '2020–kini', range: () => ['2020-01-01', ''] },
];

function holding(days: number | null): string {
  if (days === null) return '–';
  const d = Math.floor(days);
  const h = Math.round((days - d) * 24);
  return `${d} hari ${h} jam`;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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

function StreakBox({ title, tone, data }: { title: string; tone: 'win' | 'loss'; data: { byTrade: Streak; byPips: Streak } }) {
  const row = (label: string, s: Streak) => (
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

function OverallView({ o, initial }: { o: Overall; initial: number }) {
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

function MonthView({ pips, money }: { pips: MonthTable; money: MonthTable }) {
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

function CompareBox({ all, live, off }: { all: Overall; live: Overall; off: string[] }) {
  const R = (v: number | null) => (v === null ? '–' : `${v >= 0 ? '+' : ''}${num(v, 2)}R`);
  const rows: [string, string, string][] = [
    ['Total profit', fmtMoney(all.profit), fmtMoney(live.profit)],
    ['Expectancy', R(all.expectancyR), R(live.expectancyR)],
    ['Profit factor (pips)', all.profitFactor === null ? '–' : num(all.profitFactor, 2), live.profitFactor === null ? '–' : num(live.profitFactor, 2)],
    ['Max drawdown', pct(all.maxDrawdownPct), pct(live.maxDrawdownPct)],
    ['Kalah beruntun', String(all.consecutiveLoss.byTrade.count), String(live.consecutiveLoss.byTrade.count)],
    ['Total trade', String(all.trades), String(live.trades)],
    ['Posisi bersamaan maks', String(all.peakOpen), String(live.peakOpen)],
  ];
  return (
    <div className="compare">
      <p className="muted">
        Mengecualikan: <b>{off.join(', ')}</b>. Balance dan ukuran risiko dihitung ulang tanpa pair itu.
      </p>
      <table className="orders tabular">
        <thead>
          <tr>
            <th />
            <th className="num">Semua pair</th>
            <th className="num">Pair aktif</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, a, b]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="num">{a}</td>
              <td className="num">
                <b>{b}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type SortKey = 'symbol' | 'trades' | 'winRate' | 'profitFactor' | 'expectancyR' | 'pips' | 'profit' | 'maxDrawdownR' | 'maxLossStreak' | 'perYear';

function PairsView({ pairs, worst, onPick, onToggle, onSet }: { pairs: PairRow[]; worst: string[]; onPick: (symbol: string) => void; onToggle: (symbol: string) => void; onSet: (off: string[]) => void }) {
  const activeCount = pairs.filter((p) => p.active).length;
  const [key, setKey] = useState<SortKey>('expectancyR');
  const [desc, setDesc] = useState(true);
  const rows = useMemo(() => {
    const v = (p: PairRow) => (p[key] ?? (desc ? -Infinity : Infinity)) as number | string;
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
        Kualitas tiap pair dari hasil run yang sama. Nilai: Bagus = expectancy ≥ 0,15R dan profit factor ≥ 1,3; Cukup = positif; Lemah = rugi; di bawah 30 trade tidak dinilai. Klik pair untuk lihat ringkasannya. Hilangkan centang
        untuk mengecualikan pair dari perhitungan (hanya backtest; tidak mengubah trading live).
      </p>
      <div className="modal-tools">
        <span className="muted">
          {activeCount} dari {pairs.length} pair aktif
        </span>
        <button type="button" onClick={() => onSet(worst)} disabled={!worst.length}>
          Buang {worst.length} terbawah
        </button>
        <button type="button" onClick={() => onSet([])} disabled={activeCount === pairs.length}>
          Pilih semua
        </button>
      </div>
      <div className="table-scroll">
        <table className="orders tabular">
          <thead>
            <tr>
              <th aria-label="Ikut dihitung" />
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
              <tr key={p.symbol} className={p.active ? 'clickable' : 'clickable off'} onClick={() => p.active && onPick(p.symbol)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={p.active} disabled={p.active && activeCount === 1} onChange={() => onToggle(p.symbol)} aria-label={`Hitung ${p.symbol}`} />
                </td>
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
                  {p.gapDays > 0 && (
                    <span className="error" title={`${p.gapDays} hari tanpa candle di rentang uji`}>
                      {' '}
                      ⚠ bolong {Math.round(p.gapDays / 30)} bln
                    </span>
                  )}
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
  const [symbol, setSymbol] = useState('ALL');
  const [tab, setTab] = useState<Tab>('overall');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'running' | 'done'>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [run, setRun] = useState<(BacktestRun & { initial: number; riskPct: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(readExcluded().excluded));

  useEffect(() => () => worker.current?.terminate(), []);

  // a choice made for another set of pairs no longer applies
  useEffect(() => {
    if (!run) return;
    const all = run.coverage.map((c) => c.symbol).join(',');
    const saved = readExcluded();
    if (saved.all && saved.all !== all) {
      setExcluded(new Set());
      writeExcluded({ all, excluded: [] });
    } else writeExcluded({ all, excluded: saved.excluded });
  }, [run]);

  const setOff = (next: Set<string>) => {
    setExcluded(next);
    if (symbol !== 'ALL' && next.has(symbol)) setSymbol('ALL');
    writeExcluded({ all: (run?.coverage ?? []).map((c) => c.symbol).join(','), excluded: [...next] });
  };

  const start = async () => {
    const b = Number(balance);
    const r = Number(risk);
    if (!(b > 0) || !(r > 0)) {
      setError('Balance dan risk harus lebih dari 0');
      return;
    }
    if (from && to && from > to) {
      setError('Tanggal "Dari" harus sebelum "Sampai"');
      return;
    }
    worker.current?.terminate();
    setError(null);
    setRun(null);
    setSymbol('ALL');
    setPhase('loading');
    try {
      const { sr, symbols } = await api.backtestCandles();
      const w = new Worker(new URL('../backtest.worker.ts', import.meta.url), { type: 'module' });
      worker.current = w;
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === 'progress') setProgress({ done: m.done, total: m.total });
        else if (m.type === 'done') {
          setRun({ ...m.run, initial: b, riskPct: r });
          setPhase('done');
          w.terminate();
        } else {
          setError(m.message);
          setPhase('idle');
          w.terminate();
        }
      };
      w.onerror = (e) => {
        setError(e.message || 'Worker gagal');
        setPhase('idle');
      };
      setProgress({ done: 0, total: symbols.length });
      setPhase('running');
      const msg: WorkerIn = {
        symbols,
        sr,
        balance: b,
        riskPct: r,
        ...(from ? { from: Date.parse(`${from}T00:00:00Z`) } : {}),
        ...(to ? { to: Date.parse(`${to}T00:00:00Z`) } : {}),
      };
      w.postMessage(msg);
    } catch (e) {
      setError((e as Error).message);
      setPhase('idle');
    }
  };

  // every view is computed here from the trades; switching pair or excluding pairs costs milliseconds
  const view = useMemo(() => {
    if (!run) return null;
    const live = withoutPairs(run.trades, excluded, run.initial, run.riskPct);
    const trades = symbol === 'ALL' ? live : live.filter((t) => t.symbol === symbol);
    const group = (ts: typeof run.trades) => {
      const m = new Map<string, typeof run.trades>();
      for (const t of ts) m.set(t.symbol, [...(m.get(t.symbol) ?? []), t]);
      return m;
    };
    const full = group(run.trades);
    const kept = group(live);
    const pairs = run.coverage.map((c): PairRow => {
      const active = !excluded.has(c.symbol);
      return { ...pairStats(c.symbol, (active ? kept : full).get(c.symbol) ?? [], run.initial), tier: c.tier, years: c.years, gapDays: c.gapDays, active };
    });
    // the weakest by the full run, so the suggestion does not move as pairs are switched off
    const worst = run.coverage
      .map((c) => ({ symbol: c.symbol, s: pairStats(c.symbol, full.get(c.symbol) ?? [], run.initial) }))
      .filter((x) => x.s.grade !== 'few' && x.s.expectancyR !== null)
      .sort((a, b) => a.s.expectancyR! - b.s.expectancyR!)
      .slice(0, WORST_COUNT)
      .map((x) => x.symbol);
    return {
      trades,
      overall: overall(trades, run.initial),
      liveAll: symbol === 'ALL' ? null : overall(live, run.initial),
      baseline: excluded.size ? overall(run.trades, run.initial) : null,
      monthsPips: monthTable(trades, (t) => t.pips),
      monthsMoney: monthTable(trades, (t) => t.profit),
      curve: thin(equityCurve(trades, run.initial), 600),
      pairs,
      worst,
    };
  }, [run, symbol, excluded]);

  const save = (detail: boolean) => {
    if (!view) return;
    const name = `backtest-${symbol === 'ALL' ? 'semua-pair' : symbol}${detail ? '-detail' : ''}.csv`;
    download(new Blob([tradesCsv(view.trades, detail)], { type: 'text/csv;charset=utf-8' }), name);
  };

  const cov = run?.coverage ?? [];
  const minYears = cov.length ? Math.min(...cov.map((c) => c.years)) : 0;
  const gapPairs = cov.filter((c) => c.gapDays > 0);
  const shortPairs = cov.filter((c) => c.tier === 'short' || c.tier === 'none');
  const tabs: [Tab, string][] = [['overall', 'Overall'], ['month', 'Per Month'], ['growth', 'Growth'], ['pairs', 'Pair']];
  const busy = phase === 'loading' || phase === 'running';

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
          Dari <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          Sampai <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
          {busy ? 'Memproses…' : 'Jalankan'}
        </button>
      </div>
      <div className="chips" role="group" aria-label="Rentang cepat">
        {RANGES.map((r) => {
          const [f, t] = r.range();
          return (
            <button
              key={r.label}
              type="button"
              className={f === from && t === to ? 'chip active' : 'chip'}
              onClick={() => {
                setFrom(f);
                setTo(t);
              }}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <p className="muted">
        Compounding: tiap trade berisiko {risk || '…'}% dari balance saat fill (hanya trade yang sudah close sebelum hari itu). Semua pair aktif, satu balance. Memakai pengaturan S/R yang tersimpan.
        Dihitung di browser Anda; server hanya mengirim candle.
      </p>
      {error && <p className="error">{error}</p>}
      {phase === 'loading' && (
        <p className="muted" role="status">
          Mengunduh candle dari server…
        </p>
      )}
      {phase === 'running' && (
        <p className="muted" role="status">
          Memproses pair {progress.done}/{progress.total}…
        </p>
      )}

      {run && view && phase === 'done' && (
        <>
          {(minYears < 2 || shortPairs.length > 0) && (
            <p className="banner-warn">
              Data teruji hanya {fmtYears(minYears)}
              {shortPairs.length === cov.length ? ' di semua pair' : ` di ${shortPairs.map((c) => c.symbol).join(', ')}`}. Minimum 2 tahun; 5 / 10 / 20 tahun lebih meyakinkan. Tambah riwayat candle D1 (backfill) dulu sebelum mengandalkan angka ini.
            </p>
          )}
          {gapPairs.length > 0 && (
            <p className="banner-warn">
              Ada lubang di riwayat candle:{' '}
              {gapPairs
                .map((c) => `${c.symbol} ${c.gaps.slice(0, 2).map((g) => `${isoDay(g.from)} → ${isoDay(g.to)}`).join(', ')}${c.gaps.length > 2 ? ', …' : ''}`)
                .join(' · ')}
              . Trade tidak dibuat di hari yang hilang dan garis S/R di sekitarnya kurang akurat. Lengkapi lewat backfill EA atau CSV.
            </p>
          )}
          <div className="modal-tools">
            <label className="inline">
              Pair{' '}
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Pair">
                <option value="ALL">Semua pair</option>
                {view.pairs.filter((p) => p.active).map((p) => (
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
            <button type="button" onClick={() => save(false)} disabled={!view.trades.length}>
              Unduh CSV
            </button>
            <button type="button" onClick={() => save(true)} disabled={!view.trades.length}>
              CSV detail
            </button>
          </div>
          {symbol !== 'ALL' && <p className="muted">Hanya {symbol}. Profit = bagian pair ini dari run bersama.</p>}
          {view.baseline && <CompareBox all={view.baseline} live={view.liveAll ?? view.overall} off={[...excluded].sort()} />}

          {tab === 'overall' && <OverallView o={view.overall} initial={run.initial} />}
          {tab === 'month' && <MonthView pips={view.monthsPips} money={view.monthsMoney} />}
          {tab === 'growth' && <GrowthChart curve={view.curve} scope={symbol} />}
          {tab === 'pairs' && (
            <PairsView
              pairs={view.pairs}
              worst={view.worst}
              onToggle={(s) => {
                const next = new Set(excluded);
                if (next.has(s)) next.delete(s);
                else next.add(s);
                setOff(next);
              }}
              onSet={(off) => setOff(new Set(off))}
              onPick={(s) => {
                setSymbol(s);
                setTab('overall');
              }}
            />
          )}

          <p className="muted foot-note">
            Candle D1: untuk trade yang entry dan exit-nya satu hari, urutan harga dibaca open-low-high-close (candle naik) atau open-high-low-close (candle turun). {view.overall.ambiguous} dari {view.overall.trades} trade
            ({view.overall.trades ? pct((view.overall.ambiguous / view.overall.trades) * 100, 1) : '–'}) hasilnya berubah bila urutannya terbalik. Jika SL dan TP kena di candle yang sama setelah posisi terbuka, SL dihitung dulu. Spread, komisi, dan slippage tidak dihitung, jadi hasil lebih optimis dari akun nyata. Warm-up {run.warmup} candle.
          </p>
        </>
      )}
    </Modal>
  );
}
