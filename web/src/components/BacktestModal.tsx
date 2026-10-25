import { AreaSeries, ColorType, createChart, PriceScaleMode, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type SavedBacktest } from '../api.ts';
import type { WorkerIn, WorkerOut, WorkerSymbol } from '../backtest.worker.ts';
import { fingerprintOf, loadCandles, loadLastResult, loadUi, pack, sameSr, saveCandles, saveLastResult, saveUi, unpack, type BtResult } from '../backtestStore.ts';
import { compound, costPipsOf, DEFAULT_COSTS, toRaw, withCosts, type CostSettings, type Coverage, type RawTrade } from '../engine/backtest.ts';
import {
  equityCurve,
  monthReturns,
  monthTable,
  overall,
  pairStats,
  thin,
  tradesCsv,
  type BtTrade,
  type DrawdownEpisode,
  type MonthTable,
  type Overall,
  type PairGrade,
  type PairStats,
  type Streak,
} from '../engine/backtestStats.ts';
import type { SrParams } from '../engine/types.ts';
import { fmtDate, fmtMoney } from '../format.ts';
import { BacktestChart } from './BacktestChart.tsx';
import { Modal } from './Modal.tsx';

type Props = { onClose: () => void };
// grossR: expectancy before costs; costR: what the costs take per trade (gross - net)
type PairRow = PairStats & { tier: Coverage['tier']; years: number; gapDays: number; active: boolean; grossR: number | null; costR: number | null };
type Basis = 'net' | 'gross';
type Tab = 'overall' | 'month' | 'growth' | 'chart' | 'pairs';
const TABS: Tab[] = ['overall', 'month', 'growth', 'chart', 'pairs'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const GRADE: Record<PairGrade, string> = { good: 'Bagus', ok: 'Cukup', weak: 'Lemah', few: 'Data kurang' };
const TIER: Record<Coverage['tier'], string> = { none: 'tanpa data', short: '< 2 th', min: '2 th', good: '5 th', better: '10 th', perfect: '20 th' };

const num = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '–' : v.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '–' : `${num(v, d)}%`);
const sign = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? '' : v > 0 ? 'ok' : 'error');
const fmtR = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${v >= 0 ? '+' : ''}${num(v, 2)}R`);
// mean R per trade, which does not depend on balance or risk
const meanR = (ts: RawTrade[]) => (ts.length ? ts.reduce((s, t) => s + t.r, 0) / ts.length : null);
const fmtYears = (y: number) => (y >= 1 ? `${num(y, 1)} tahun` : `${Math.round(y * 12)} bulan`);

// Before the inputs moved to IndexedDB the excluded pairs lived here; read once as a fallback.
const EXCLUDED_KEY = 'dp77.backtest.excluded';
function oldExcluded(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(EXCLUDED_KEY) ?? 'null') as { excluded?: unknown } | null;
    if (v && Array.isArray(v.excluded)) return v.excluded.filter((x): x is string => typeof x === 'string');
  } catch {
    /* storage blocked or corrupt: start with every pair */
  }
  return [];
}

const WORST_COUNT = 4;

// Results stored before open trades were left out still have them; a trade with no result
// has no place in a backtest.
const closedOnly = (raw: RawTrade[]) => raw.filter((t) => t.result !== 'Open');

// Market-regime blocks, so a pair can be judged on how many regimes it survives. The
// analyses still read the candles before "Dari" as warm-up.
const RANGES: { label: string; title: string; range: () => [string, string] }[] = [
  { label: '2010–12', title: 'Krisis utang Eropa, risk-off', range: () => ['2010-01-01', '2012-12-31'] },
  { label: '2013–15', title: 'Abenomics (yen melemah), USD menguat 2014', range: () => ['2013-01-01', '2015-12-31'] },
  { label: '2016–19', title: 'Volatilitas rendah, banyak ranging', range: () => ['2016-01-01', '2019-12-31'] },
  { label: '2020–21', title: 'COVID, lonjakan volatilitas', range: () => ['2020-01-01', '2021-12-31'] },
  { label: '2022–24', title: 'Kenaikan suku bunga, yen melemah tajam', range: () => ['2022-01-01', '2024-12-31'] },
  { label: '2025–kini', title: 'Out-of-sample terbaru', range: () => ['2025-01-01', ''] },
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

function Tile({ label, value, sub, cls }: { label: string; value: string; sub?: ReactNode; cls?: string }) {
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

// Under a drawdown figure: the other size of the same fall and its dates.
function Episode({ ep, show }: { ep: DrawdownEpisode | null; show: 'pct' | 'amount' }) {
  if (!ep) return <>tidak ada penurunan</>;
  return (
    <>
      {show === 'pct' ? `= ${pct(ep.pct)} dari puncak` : `= ${fmtMoney(ep.amount)}`}
      <br />
      {fmtDate(ep.peakAt)} → {fmtDate(ep.troughAt)}
      <br />
      {ep.recoveredAt === null ? 'belum pulih' : `pulih ${fmtDate(ep.recoveredAt)}`}
    </>
  );
}

function OverallView({ o, initial, grossR }: { o: Overall; initial: number; grossR: number | null | undefined }) {
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
        <Tile
          label={grossR === undefined ? 'Expectancy' : 'Expectancy (net)'}
          value={fmtR(o.expectancyR)}
          cls={sign(o.expectancyR)}
          sub={grossR === undefined ? 'rata-rata R per trade' : `gross ${fmtR(grossR)} · biaya ${fmtR(grossR === null || o.expectancyR === null ? null : o.expectancyR - grossR)}`}
        />
        <Tile label="Max drawdown (nilai)" value={fmtMoney(o.maxDrawdown)} sub={<Episode ep={o.maxDrawdownByAmount} show="pct" />} cls={o.maxDrawdown ? 'error' : ''} />
        <Tile label="Max drawdown (%)" value={pct(o.maxDrawdownPct)} sub={<Episode ep={o.maxDrawdownByPct} show="amount" />} cls={o.maxDrawdownPct ? 'error' : ''} />
        <Tile label="Posisi bersamaan maks" value={String(o.peakOpen)} sub={`≈ ${o.peakOpen}× risiko per trade`} />
        <Tile label="Bergantung urutan intraday" value={String(o.ambiguous)} sub={o.trades ? pct((o.ambiguous / o.trades) * 100, 1) : undefined} />
        <Tile label="Balance awal" value={fmtMoney(initial)} sub={`akhir ${fmtMoney(initial + o.profit)}`} />
      </div>
    </>
  );
}

function MonthView({ pips, money, returns, counts, scope }: { pips: MonthTable; money: MonthTable; returns: MonthTable; counts: MonthTable; scope: string }) {
  const [unit, setUnit] = useState<'pips' | 'money' | 'pct' | 'trades'>('pips');
  const t = unit === 'pips' ? pips : unit === 'money' ? money : unit === 'pct' ? returns : counts;
  const f = (v: number | null) => (v === null ? '-' : unit === 'pips' ? num(v) : unit === 'money' ? fmtMoney(v) : unit === 'pct' ? pct(v) : num(v, 0));
  // a count has no sign to colour
  const tone = (v: number | null) => (unit === 'trades' ? '' : sign(v));
  // Per calendar month across the years: the average for pips and trades, losing:winning
  // months for profit and percentage.
  const byMonth = MONTHS.map((_, i) => t.rows.map((r) => r.months[i]).filter((v): v is number => v !== null));
  const ratio = unit === 'money' || unit === 'pct';
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
          <button type="button" aria-pressed={unit === 'pct'} onClick={() => setUnit('pct')}>
            Persentase
          </button>
          <button type="button" aria-pressed={unit === 'trades'} onClick={() => setUnit('trades')}>
            Trades
          </button>
        </span>
        <span className="muted">
          Dihitung pada bulan close trade.
          {unit === 'pct' &&
            ` Bulan = profit bulan itu / balance awal bulan${scope === 'ALL' ? '' : ` (balance awal + kontribusi ${scope})`}; YTD = return majemuk setahun; Total = balance akhir / balance awal − 1.`}
        </span>
      </div>
      <div className="table-full">
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
                  <td key={i} className={`num ${tone(v)}`}>
                    {f(v)}
                  </td>
                ))}
                <td className={`num ${tone(r.ytd)}`}>
                  <b>{f(r.ytd)}</b>
                </td>
              </tr>
            ))}
            <tr className="months-total">
              <th>
                Total
                <span className="reason">{ratio ? 'kalah:menang' : 'rata-rata'}</span>
              </th>
              {byMonth.map((vs, i) => {
                if (!vs.length) return <td key={i} className="num">-</td>;
                if (!ratio) {
                  const avg = vs.reduce((s, v) => s + v, 0) / vs.length;
                  return (
                    <td key={i} className={`num ${tone(avg)}`}>
                      {unit === 'trades' ? num(avg, 1) : num(avg)}
                    </td>
                  );
                }
                const lose = vs.filter((v) => v < 0).length;
                const win = vs.filter((v) => v > 0).length;
                return (
                  <td key={i} className="num">
                    {lose}:{win}
                    <span className={`reason ${lose > win ? 'error' : 'muted'}`}>{lose + win ? pct((lose / (lose + win)) * 100, 0) : '–'}</span>
                  </td>
                );
              })}
              <td className={`num ${tone(t.total)}`}>
                <b>{f(t.total)}</b>
                {unit === 'pct' && <span className="reason muted">majemuk</span>}
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
    ['Max drawdown (nilai)', fmtMoney(all.maxDrawdown), fmtMoney(live.maxDrawdown)],
    ['Max drawdown (%)', pct(all.maxDrawdownPct), pct(live.maxDrawdownPct)],
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

type SortKey = 'symbol' | 'trades' | 'winRate' | 'profitFactor' | 'expectancyR' | 'grossR' | 'costR' | 'pips' | 'profit' | 'maxDrawdownR' | 'maxLossStreak' | 'perYear';

function PairsView({ pairs, worst, net, onPick, onToggle, onSet }: { pairs: PairRow[]; worst: string[]; net: boolean; onPick: (symbol: string) => void; onToggle: (symbol: string) => void; onSet: (off: string[]) => void }) {
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
        Kualitas tiap pair dari hasil run yang sama{net ? ', setelah spread dan slippage (net)' : ', tanpa biaya (gross)'}. Nilai: Bagus = expectancy ≥ 0,15R dan profit factor ≥ 1,3; Cukup = positif; Lemah = rugi; di bawah 30 trade tidak dinilai. Klik pair untuk lihat ringkasannya. Hilangkan centang
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
              {th('expectancyR', net ? 'Exp. net' : 'Expectancy')}
              {net && th('grossR', 'Exp. gross')}
              {net && th('costR', 'Biaya/trade')}
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
                <td className={`num ${sign(p.expectancyR)}`}>{fmtR(p.expectancyR)}</td>
                {net && <td className={`num muted`}>{fmtR(p.grossR)}</td>}
                {net && (
                  <td className="num" title={p.grossR && p.costR !== null ? `${pct((-p.costR / p.grossR) * 100, 0)} dari edge gross` : undefined}>
                    {p.costR === null ? '–' : `${num(p.costR, 2)}R`}
                    {p.grossR !== null && p.grossR > 0 && p.costR !== null && <span className="muted"> ({pct((-p.costR / p.grossR) * 100, 0)})</span>}
                  </td>
                )}
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
  // what the numbers are computed with: the inputs once valid, a moment after typing stops
  const [money, setMoney] = useState({ balance: 6000, riskPct: 1 });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [symbol, setSymbol] = useState('ALL');
  const [tab, setTab] = useState<Tab>('overall');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'running'>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<BtResult | null>(null);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [currentSr, setCurrentSr] = useState<SrParams | null>(null);
  const [costs, setCosts] = useState<CostSettings>(DEFAULT_COSTS);
  const [basis, setBasis] = useState<Basis>('net');
  const [candles, setCandles] = useState<WorkerSymbol[] | null>(null);
  const [chartState, setChartState] = useState<{ loading: boolean; failed: string | null }>({ loading: false, failed: null });
  const [saved, setSaved] = useState<SavedBacktest[]>([]);
  const [saveName, setSaveName] = useState('');
  const [savedBusy, setSavedBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => () => worker.current?.terminate(), []);

  // the last result and inputs of this browser, the S/R settings now, the saved results
  useEffect(() => {
    let stop = false;
    void (async () => {
      const [last, ui] = await Promise.all([loadLastResult(), loadUi()]);
      if (stop) return;
      if (ui) {
        setBalance(ui.balance);
        setRisk(ui.risk);
        if (Number(ui.balance) > 0 && Number(ui.risk) > 0) setMoney({ balance: Number(ui.balance), riskPct: Number(ui.risk) });
        setFrom(ui.from);
        setTo(ui.to);
        setSymbol(ui.symbol);
        if (TABS.includes(ui.tab as Tab)) setTab(ui.tab as Tab);
        setExcluded(new Set(ui.excluded));
      } else setExcluded(new Set(oldExcluded()));
      if (last) setResult({ ...last, raw: closedOnly(last.raw) });
      setRestored(true);
    })();
    api.settings().then(
      (s) => {
        if (stop) return;
        setCurrentSr(s.sr as unknown as SrParams);
        setCosts({ ...DEFAULT_COSTS, ...s.costs });
      },
      () => {},
    );
    api.savedBacktests().then((r) => !stop && setSaved(r.backtests), () => {});
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    const b = Number(balance);
    const r = Number(risk);
    if (!(b > 0) || !(r > 0)) return;
    const id = setTimeout(() => setMoney({ balance: b, riskPct: r }), 250);
    return () => clearTimeout(id);
  }, [balance, risk]);

  // inputs are remembered on every change; the result only when it is a new one
  useEffect(() => {
    if (restored) void saveUi({ balance, risk, from, to, symbol, tab, excluded: [...excluded] });
  }, [restored, balance, risk, from, to, symbol, tab, excluded]);
  useEffect(() => {
    if (restored && result) void saveLastResult(result);
  }, [restored, result]);

  const setOff = (next: Set<string>) => {
    setExcluded(next);
    if (symbol !== 'ALL' && next.has(symbol)) setSymbol('ALL');
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
    setSavedMsg(null);
    setPhase('loading');
    try {
      const { sr, symbols } = await api.backtestCandles();
      const runFrom = from;
      const runTo = to;
      const w = new Worker(new URL('../backtest.worker.ts', import.meta.url), { type: 'module' });
      worker.current = w;
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === 'progress') setProgress({ done: m.done, total: m.total });
        else if (m.type === 'done') {
          const names = new Set(m.run.coverage.map((c) => c.symbol));
          setResult({ raw: toRaw(m.run.trades), coverage: m.run.coverage, warmup: m.run.warmup, sr, from: runFrom, to: runTo, fingerprint: fingerprintOf(symbols) });
          setMoney({ balance: b, riskPct: r });
          // a pair that is not in this run cannot stay excluded or selected
          setExcluded((prev) => new Set([...prev].filter((s) => names.has(s))));
          setSymbol((prev) => (names.has(prev) ? prev : 'ALL'));
          setCurrentSr(sr);
          setPhase('idle');
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
      setCandles(symbols);
      setChartState({ loading: false, failed: null });
      void saveCandles(symbols);
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

  // Chart tab: candles of the picked pair from the last download (memory, then IndexedDB),
  // fetched from the server only when this browser has none for it.
  useEffect(() => {
    if (tab !== 'chart' || symbol === 'ALL' || !result || chartState.loading || chartState.failed === symbol) return;
    if (candles?.some((s) => s.name === symbol)) return;
    // no cancel flag: the loading state change re-runs this effect, and the candles are wanted either way
    void (async () => {
      let list = candles ?? (await loadCandles()) ?? [];
      if (!list.some((s) => s.name === symbol)) {
        setChartState({ loading: true, failed: null });
        try {
          const { symbols } = await api.backtestCandles([symbol]);
          list = [...list.filter((s) => s.name !== symbol), ...symbols];
          void saveCandles(list);
          setChartState({ loading: false, failed: null });
        } catch (e) {
          setChartState({ loading: false, failed: symbol });
          setError((e as Error).message);
          return;
        }
      }
      setCandles(list);
    })();
  }, [tab, symbol, result, candles, chartState]);

  // costs come from Pengaturan > Biaya backtest; off there means gross only
  const net = costs.enabled && basis === 'net';
  // spread + slippage per pair, for the footnote
  const costList = useMemo(() => {
    if (!result) return '';
    const digits = new Map(result.raw.map((t) => [t.symbol, t.digits]));
    return result.coverage
      .filter((c) => digits.has(c.symbol))
      .map((c) => `${c.symbol} ${num(costPipsOf(c.symbol, digits.get(c.symbol)!, { ...costs, slippagePips: 0 }), 1)}`)
      .join(', ');
  }, [result, costs]);

  // every view is computed here from the raw trades; balance, risk, pair and excluded pairs
  // cost milliseconds, only dates and S/R settings need a new replay
  const view = useMemo(() => {
    if (!result) return null;
    const initial = money.balance;
    const raw = net ? withCosts(result.raw, costs) : result.raw;
    const all = compound(raw, initial, money.riskPct);
    const live = excluded.size ? compound(raw.filter((t) => !excluded.has(t.symbol)), initial, money.riskPct) : all;
    const grossOf = (keep: (t: RawTrade) => boolean) => meanR(result.raw.filter(keep));
    const trades = symbol === 'ALL' ? live : live.filter((t) => t.symbol === symbol);
    const group = (ts: BtTrade[]) => {
      const m = new Map<string, BtTrade[]>();
      for (const t of ts) m.set(t.symbol, [...(m.get(t.symbol) ?? []), t]);
      return m;
    };
    const full = group(all);
    const kept = group(live);
    const pairs = result.coverage.map((c): PairRow => {
      const active = !excluded.has(c.symbol);
      const st = pairStats(c.symbol, (active ? kept : full).get(c.symbol) ?? [], initial);
      const grossR = grossOf((t) => t.symbol === c.symbol);
      const costR = grossR === null || st.expectancyR === null ? null : st.expectancyR - grossR;
      return { ...st, tier: c.tier, years: c.years, gapDays: c.gapDays, active, grossR: grossR === null ? null : Math.round(grossR * 1000) / 1000, costR };
    });
    // the weakest by the full run, so the suggestion does not move as pairs are switched off
    const worst = result.coverage
      .map((c) => ({ symbol: c.symbol, s: pairStats(c.symbol, full.get(c.symbol) ?? [], initial) }))
      .filter((x) => x.s.grade !== 'few' && x.s.expectancyR !== null)
      .sort((a, b) => a.s.expectancyR! - b.s.expectancyR!)
      .slice(0, WORST_COUNT)
      .map((x) => x.symbol);
    return {
      initial,
      trades,
      overall: overall(trades, initial),
      // expectancy of the same trades before costs, for the Overall tab
      grossR: net ? grossOf((t) => !excluded.has(t.symbol) && (symbol === 'ALL' || t.symbol === symbol)) : undefined,
      liveAll: symbol === 'ALL' ? null : overall(live, initial),
      baseline: excluded.size ? overall(all, initial) : null,
      monthsPips: monthTable(trades, (t) => t.pips),
      monthsMoney: monthTable(trades, (t) => t.profit),
      monthsPct: monthReturns(trades, initial),
      monthsTrades: monthTable(trades, () => 1),
      curve: thin(equityCurve(trades, initial), 600),
      pairs,
      worst,
    };
  }, [result, money, symbol, excluded, net, costs]);

  const save = (detail: boolean) => {
    if (!view) return;
    const name = `backtest-${symbol === 'ALL' ? 'semua-pair' : symbol}${detail ? '-detail' : ''}.csv`;
    download(new Blob([tradesCsv(view.trades, detail)], { type: 'text/csv;charset=utf-8' }), name);
  };

  // --- named results on the server ---
  const refreshSaved = () => api.savedBacktests().then((r) => setSaved(r.backtests));

  const withSaved = async (work: () => Promise<string | void>) => {
    setSavedBusy(true);
    setSavedMsg(null);
    setError(null);
    try {
      const msg = await work();
      if (msg) setSavedMsg(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavedBusy(false);
    }
  };

  const storeResult = () =>
    withSaved(async () => {
      if (!result) return;
      const name = saveName.trim();
      const { backtest } = await api.saveBacktest({
        name,
        balance: money.balance,
        riskPct: money.riskPct,
        from: result.from || null,
        to: result.to || null,
        excluded: [...excluded].sort(),
        sr: result.sr as unknown as SavedBacktest['sr'],
        warmup: result.warmup,
        coverage: result.coverage,
        fingerprint: result.fingerprint,
        trades: result.raw.map(pack),
      });
      setResult({ ...result, saved: { id: backtest.id, name: backtest.name } });
      setSaveName('');
      await refreshSaved();
      return `Tersimpan sebagai "${backtest.name}"`;
    });

  const openSaved = (id: string) =>
    withSaved(async () => {
      if (!id) return;
      const b = await api.savedBacktest(id);
      worker.current?.terminate();
      setPhase('idle');
      setResult({
        raw: closedOnly(b.trades.map(unpack)),
        coverage: b.coverage,
        warmup: b.warmup,
        sr: b.sr as unknown as SrParams,
        from: b.from ?? '',
        to: b.to ?? '',
        fingerprint: b.fingerprint,
        saved: { id: b.id, name: b.name },
      });
      setBalance(String(b.balance));
      setRisk(String(b.riskPct));
      setMoney({ balance: b.balance, riskPct: b.riskPct });
      setFrom(b.from ?? '');
      setTo(b.to ?? '');
      setExcluded(new Set(b.excluded));
      setSymbol('ALL');
    });

  const renameSaved = () =>
    withSaved(async () => {
      if (!result?.saved) return;
      const { backtest } = await api.renameBacktest(result.saved.id, saveName.trim());
      setResult({ ...result, saved: { id: backtest.id, name: backtest.name } });
      setSaveName('');
      await refreshSaved();
      return `Nama diganti jadi "${backtest.name}"`;
    });

  const deleteSaved = () =>
    withSaved(async () => {
      if (!result?.saved || !window.confirm(`Hapus hasil tersimpan "${result.saved.name}"? Hasil yang tampil sekarang tetap ada di browser ini.`)) return;
      await api.deleteBacktest(result.saved.id);
      const { saved: _gone, ...rest } = result;
      setResult(rest);
      await refreshSaved();
      return 'Hasil tersimpan dihapus';
    });

  const cov = result?.coverage ?? [];
  const minYears = cov.length ? Math.min(...cov.map((c) => c.years)) : 0;
  const gapPairs = cov.filter((c) => c.gapDays > 0);
  const shortPairs = cov.filter((c) => c.tier === 'short' || c.tier === 'none');
  const tabs: [Tab, string][] = [['overall', 'Overall'], ['month', 'Per Month'], ['growth', 'Growth'], ['chart', 'Chart'], ['pairs', 'Pair']];
  const busy = phase === 'loading' || phase === 'running';
  const datesChanged = !!result && (from !== result.from || to !== result.to);
  const srChanged = !!result && !!currentSr && !sameSr(result.sr, currentSr);
  const chartData = symbol === 'ALL' ? undefined : candles?.find((s) => s.name === symbol);
  const range = (f: string, t: string) => `${f || 'awal data'} – ${t || 'candle terakhir'}`;

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
              title={r.title}
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
        Dihitung di browser Anda; server hanya mengirim candle. Balance dan risk langsung dihitung ulang; Jalankan hanya perlu bila tanggal atau pengaturan S/R berubah.
      </p>
      <div className="modal-tools saved-bar">
        <label className="inline">
          Hasil tersimpan{' '}
          <select value={result?.saved?.id ?? ''} onChange={(e) => void openSaved(e.target.value)} disabled={savedBusy || busy} aria-label="Hasil tersimpan">
            <option value="">{saved.length ? '— pilih —' : '— belum ada —'}</option>
            {saved.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.tradeCount} trade · {range(s.from ?? '', s.to ?? '')}
                {currentSr && !sameSr(s.sr as unknown as SrParams, currentSr) ? ' · S/R beda' : ''}
              </option>
            ))}
          </select>
        </label>
        {result && (
          <>
            <input type="text" placeholder="Nama hasil" maxLength={80} value={saveName} onChange={(e) => setSaveName(e.target.value)} aria-label="Nama hasil" />
            <button type="button" onClick={() => void storeResult()} disabled={savedBusy || busy || !saveName.trim()}>
              Simpan
            </button>
            {result.saved && (
              <>
                <button type="button" onClick={() => void renameSaved()} disabled={savedBusy || !saveName.trim()} title={`Ganti nama "${result.saved.name}" jadi nama di kolom`}>
                  Ganti nama
                </button>
                <button type="button" onClick={() => void deleteSaved()} disabled={savedBusy}>
                  Hapus
                </button>
              </>
            )}
          </>
        )}
        {savedMsg && (
          <span className="ok" role="status">
            {savedMsg}
          </span>
        )}
      </div>
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

      {result && view && !busy && (
        <>
          <p className="muted">
            {result.saved ? (
              <>
                Hasil tersimpan <b>{result.saved.name}</b>
              </>
            ) : (
              'Hasil terakhir'
            )}
            : rentang {range(result.from, result.to)}, {result.raw.length} trade.
            {datesChanged && <span className="error"> Tanggal sudah diubah: klik Jalankan untuk menghitung rentang {range(from, to)}.</span>}
          </p>
          {srChanged && <p className="banner-warn">Hasil ini memakai pengaturan S/R yang berbeda dari pengaturan sekarang. Klik Jalankan untuk menghitung ulang dengan pengaturan sekarang.</p>}
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
            <span className="seg" role="group" aria-label="Biaya trading">
              <button type="button" aria-pressed={net} disabled={!costs.enabled} onClick={() => setBasis('net')} title={costs.enabled ? 'Setelah spread dan slippage' : 'Biaya dimatikan di Pengaturan > Biaya backtest'}>
                Net
              </button>
              <button type="button" aria-pressed={!net} onClick={() => setBasis('gross')} title="Tanpa spread, komisi, dan slippage">
                Gross
              </button>
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

          {tab === 'overall' && <OverallView o={view.overall} initial={view.initial} grossR={view.grossR} />}
          {tab === 'month' && <MonthView pips={view.monthsPips} money={view.monthsMoney} returns={view.monthsPct} counts={view.monthsTrades} scope={symbol} />}
          {tab === 'growth' && <GrowthChart curve={view.curve} scope={symbol} />}
          {tab === 'chart' &&
            (symbol === 'ALL' ? (
              <div className="chips" role="group" aria-label="Pilih pair untuk grafik">
                <span className="muted">Grafik butuh satu pair. Pilih:</span>
                {view.pairs
                  .filter((p) => p.active)
                  .map((p) => (
                    <button key={p.symbol} type="button" className="chip" onClick={() => setSymbol(p.symbol)}>
                      {p.symbol}
                    </button>
                  ))}
              </div>
            ) : chartData ? (
              <BacktestChart key={symbol} symbol={symbol} digits={chartData.digits} candles={chartData.candles} inputs={chartData.inputs} sr={result.sr} trades={view.trades} />
            ) : (
              <p className="muted" role="status">
                {chartState.failed === symbol ? 'Candle tidak bisa diambil.' : 'Mengambil candle…'}
              </p>
            ))}
          {tab === 'pairs' && (
            <PairsView
              pairs={view.pairs}
              worst={view.worst}
              net={net}
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
            ({view.overall.trades ? pct((view.overall.ambiguous / view.overall.trades) * 100, 1) : '–'}) hasilnya berubah bila urutannya terbalik. Jika SL dan TP kena di candle yang sama setelah posisi terbuka, SL dihitung dulu.{' '}
            {net ? (
              <>
                Angka <b>net</b>: tiap trade dikurangi spread{costs.slippagePips > 0 ? ` + slippage ${num(costs.slippagePips, 1)} pips` : ''} dalam pips, dan dalam R sebesar biaya / jarak SL trade itu
                (fill dan exit tetap dari candle bid). Spread (pips): {costList}. Ini perkiraan rata-rata akun Exness Standard, bukan spread broker Anda; spread
                melebar saat berita dan rollover tidak dihitung, komisi juga tidak. Ubah di Pengaturan &gt; Biaya backtest.
              </>
            ) : (
              <>Angka <b>gross</b>: spread, komisi, dan slippage tidak dihitung, jadi hasil lebih optimis dari akun nyata{costs.enabled ? '; pilih Net untuk hasil setelah spread' : ' (biaya dimatikan di Pengaturan > Biaya backtest)'}.</>
            )}{' '}
            Warm-up {result.warmup} candle.
          </p>
        </>
      )}
    </Modal>
  );
}
