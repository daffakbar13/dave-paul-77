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
import { locale, tr, useT } from '../i18n.ts';
import { BacktestChart } from './BacktestChart.tsx';
import { Modal } from './Modal.tsx';

type Props = { onClose: () => void };
// grossR: expectancy before costs; costR: what the costs take per trade (gross - net)
type PairRow = PairStats & { tier: Coverage['tier']; years: number; gapDays: number; active: boolean; grossR: number | null; costR: number | null };
type Basis = 'net' | 'gross';
type Tab = 'overall' | 'month' | 'growth' | 'chart' | 'pairs';
const TABS: Tab[] = ['overall', 'month', 'growth', 'chart', 'pairs'];

const monthNames = () => ['Jan', 'Feb', 'Mar', 'Apr', tr('Mei', 'May'), 'Jun', 'Jul', tr('Agu', 'Aug'), 'Sep', tr('Okt', 'Oct'), 'Nov', tr('Des', 'Dec')];
const gradeLabel = (g: PairGrade): string => ({ good: tr('Bagus', 'Good'), ok: tr('Cukup', 'Fair'), weak: tr('Lemah', 'Weak'), few: tr('Data kurang', 'Little data') })[g];
const tierLabel = (k: Coverage['tier']): string =>
  ({ none: tr('tanpa data', 'no data'), short: tr('< 2 th', '< 2 y'), min: tr('2 th', '2 y'), good: tr('5 th', '5 y'), better: tr('10 th', '10 y'), perfect: tr('20 th', '20 y') })[k];

const num = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '–' : v.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '–' : `${num(v, d)}%`);
const sign = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? '' : v > 0 ? 'ok' : 'error');
const fmtR = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${v >= 0 ? '+' : ''}${num(v, 2)}R`);
// mean R per trade, which does not depend on balance or risk
const meanR = (ts: RawTrade[]) => (ts.length ? ts.reduce((s, t) => s + t.r, 0) / ts.length : null);
const fmtYears = (y: number) => (y >= 1 ? tr(`${num(y, 1)} tahun`, `${num(y, 1)} years`) : tr(`${Math.round(y * 12)} bulan`, `${Math.round(y * 12)} months`));

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

// A run always ends on the last day of the previous month (WIB), so every run covers whole
// months and the current, unfinished month never counts.
export function lastMonthEnd(now = new Date()): string {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).format(now).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 0)).toISOString().slice(0, 10);
}

// Market-regime blocks, so a pair can be judged on how many regimes it survives. The
// analyses still read the candles before "Dari" as warm-up.
const ranges = (): { label: string; title: string; range: () => [string, string] }[] => [
  { label: '2010–12', title: tr('Krisis utang Eropa, risk-off', 'European debt crisis, risk-off'), range: () => ['2010-01-01', '2012-12-31'] },
  { label: '2013–15', title: tr('Abenomics (yen melemah), USD menguat 2014', 'Abenomics (weaker yen), stronger USD in 2014'), range: () => ['2013-01-01', '2015-12-31'] },
  { label: '2016–19', title: tr('Volatilitas rendah, banyak ranging', 'Low volatility, lots of ranging'), range: () => ['2016-01-01', '2019-12-31'] },
  { label: '2020–21', title: tr('COVID, lonjakan volatilitas', 'COVID, volatility spike'), range: () => ['2020-01-01', '2021-12-31'] },
  { label: '2022–24', title: tr('Kenaikan suku bunga, yen melemah tajam', 'Rate hikes, sharply weaker yen'), range: () => ['2022-01-01', '2024-12-31'] },
  { label: tr('2025–kini', '2025–now'), title: tr('Out-of-sample terbaru', 'Latest out-of-sample'), range: () => ['2025-01-01', lastMonthEnd()] },
];

function holding(days: number | null): string {
  if (days === null) return '–';
  const d = Math.floor(days);
  const h = Math.round((days - d) * 24);
  return tr(`${d} hari ${h} jam`, `${d}d ${h}h`);
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
  const t = useT();
  if (!ep) return <>{t('tidak ada penurunan', 'no drawdown')}</>;
  return (
    <>
      {show === 'pct' ? t(`= ${pct(ep.pct)} dari puncak`, `= ${pct(ep.pct)} from peak`) : `= ${fmtMoney(ep.amount)}`}
      <br />
      {fmtDate(ep.peakAt)} → {fmtDate(ep.troughAt)}
      <br />
      {ep.recoveredAt === null ? t('belum pulih', 'not recovered') : t(`pulih ${fmtDate(ep.recoveredAt)}`, `recovered ${fmtDate(ep.recoveredAt)}`)}
    </>
  );
}

function OverallView({ o, initial, grossR }: { o: Overall; initial: number; grossR: number | null | undefined }) {
  const t = useT();
  return (
    <>
      <div className="tiles tabular">
        <Tile label="Total Profit" value={fmtMoney(o.profit)} sub={pct(o.profitPct)} cls={sign(o.profit)} />
        <Tile label="Avg. Profit / Trade" value={fmtMoney(o.avgProfitTrade)} sub={pct(o.avgProfitTradePct)} cls={sign(o.profit)} />
        <Tile label={t('Avg. Profit / Bulan', 'Avg. Profit / Month')} value={fmtMoney(o.avgProfitMonth)} sub={pct(o.avgProfitMonthPct)} cls={sign(o.profit)} />
        <Tile label={t('Avg. Profit / Tahun', 'Avg. Profit / Year')} value={fmtMoney(o.avgProfitYear)} sub={pct(o.avgProfitYearPct)} cls={sign(o.profit)} />
        <Tile label="Total Pips" value={num(o.pips)} cls={sign(o.pips)} />
        <Tile label="Avg. Pips / Trade" value={num(o.avgPipsTrade)} cls={sign(o.pips)} />
        <Tile label={t('Avg. Pips / Bulan', 'Avg. Pips / Month')} value={num(o.avgPipsMonth)} cls={sign(o.pips)} />
        <Tile label={t('Avg. Pips / Tahun', 'Avg. Pips / Year')} value={num(o.avgPipsYear)} cls={sign(o.pips)} />
      </div>
      <div className="tiles big tabular">
        <Tile label={t('Total Trade', 'Total Trades')} value={`${o.trades}x`} sub={`${o.wins} TP · ${o.losses} SL`} cls="tile-blue" />
        <Tile label="Probability" value={o.probability === null ? '–' : pct(o.probability * 100)} cls="tile-green" />
        <Tile label="Avg. Risk : Reward" value={o.riskReward === null ? '–' : `${num(o.riskReward, 2)}:1`} cls="tile-orange" />
        <Tile label="Avg. Holding Period" value={holding(o.avgHoldDays)} sub={t('resolusi harian (candle D1)', 'daily resolution (D1 candles)')} cls="tile-yellow" />
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
          sub={grossR === undefined ? t('rata-rata R per trade', 'average R per trade') : t(`gross ${fmtR(grossR)} · biaya ${fmtR(grossR === null || o.expectancyR === null ? null : o.expectancyR - grossR)}`, `gross ${fmtR(grossR)} · costs ${fmtR(grossR === null || o.expectancyR === null ? null : o.expectancyR - grossR)}`)}
        />
        <Tile label={t('Max drawdown (nilai)', 'Max drawdown (amount)')} value={fmtMoney(o.maxDrawdown)} sub={<Episode ep={o.maxDrawdownByAmount} show="pct" />} cls={o.maxDrawdown ? 'error' : ''} />
        <Tile label="Max drawdown (%)" value={pct(o.maxDrawdownPct)} sub={<Episode ep={o.maxDrawdownByPct} show="amount" />} cls={o.maxDrawdownPct ? 'error' : ''} />
        <Tile label={t('Posisi bersamaan maks', 'Max concurrent positions')} value={String(o.peakOpen)} sub={t(`≈ ${o.peakOpen}× risiko per trade`, `≈ ${o.peakOpen}× risk per trade`)} />
        <Tile label={t('Bergantung urutan intraday', 'Depends on intraday order')} value={String(o.ambiguous)} sub={o.trades ? pct((o.ambiguous / o.trades) * 100, 1) : undefined} />
        <Tile label={t('Balance awal', 'Initial balance')} value={fmtMoney(initial)} sub={t(`akhir ${fmtMoney(initial + o.profit)}`, `final ${fmtMoney(initial + o.profit)}`)} />
      </div>
    </>
  );
}

function MonthView({ pips, money, returns, counts, scope }: { pips: MonthTable; money: MonthTable; returns: MonthTable; counts: MonthTable; scope: string }) {
  const t = useT();
  const MONTHS = monthNames();
  const [unit, setUnit] = useState<'pips' | 'money' | 'pct' | 'trades'>('pips');
  const tbl = unit === 'pips' ? pips : unit === 'money' ? money : unit === 'pct' ? returns : counts;
  const f = (v: number | null) => (v === null ? '-' : unit === 'pips' ? num(v) : unit === 'money' ? fmtMoney(v) : unit === 'pct' ? pct(v) : num(v, 0));
  // a count has no sign to colour
  const tone = (v: number | null) => (unit === 'trades' ? '' : sign(v));
  // Per calendar month across the years: the average for pips and trades, losing:winning
  // months for profit and percentage.
  const byMonth = MONTHS.map((_, i) => tbl.rows.map((r) => r.months[i]).filter((v): v is number => v !== null));
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
            {t('Persentase', 'Percentage')}
          </button>
          <button type="button" aria-pressed={unit === 'trades'} onClick={() => setUnit('trades')}>
            Trades
          </button>
        </span>
        <span className="muted">
          {t('Dihitung pada bulan close trade.', 'Counted in the month the trade closes.')}
          {unit === 'pct' &&
            t(
              ` Bulan = profit bulan itu / balance awal bulan${scope === 'ALL' ? '' : ` (balance awal + kontribusi ${scope})`}; YTD = return majemuk setahun; Total = balance akhir / balance awal − 1.`,
              ` Month = that month's profit / balance at the start of the month${scope === 'ALL' ? '' : ` (initial balance + ${scope} contribution)`}; YTD = compounded return over the year; Total = final balance / initial balance − 1.`,
            )}
        </span>
      </div>
      <div className="table-full">
        <table className="orders tabular months">
          <thead>
            <tr>
              <th>{t('Tahun', 'Year')}</th>
              {MONTHS.map((m) => (
                <th key={m} className="num">
                  {m}
                </th>
              ))}
              <th className="num">YTD</th>
            </tr>
          </thead>
          <tbody>
            {tbl.rows.map((r) => (
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
                <span className="reason">{ratio ? t('kalah:menang', 'lost:won') : t('rata-rata', 'average')}</span>
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
              <td className={`num ${tone(tbl.total)}`}>
                <b>{f(tbl.total)}</b>
                {unit === 'pct' && <span className="reason muted">{t('majemuk', 'compound')}</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function GrowthChart({ curve, scope }: { curve: { t: number; balance: number }[]; scope: string }) {
  const t = useT();
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
        <span className="muted">{scope === 'ALL' ? t('Equity dari balance awal, dihitung saat trade close.', 'Equity from the initial balance, counted when trades close.') : t(`Balance awal + kontribusi ${scope} saja.`, `Initial balance + ${scope} contribution only.`)}</span>
        <label className="inline">
          <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} /> {t('Skala log', 'Log scale')}
        </label>
      </div>
      <div ref={box} className="growth-chart" role="img" aria-label={t('Grafik pertumbuhan equity', 'Equity growth chart')} />
    </>
  );
}

function CompareBox({ all, live, off }: { all: Overall; live: Overall; off: string[] }) {
  const t = useT();
  const R = (v: number | null) => (v === null ? '–' : `${v >= 0 ? '+' : ''}${num(v, 2)}R`);
  const rows: [string, string, string][] = [
    ['Total profit', fmtMoney(all.profit), fmtMoney(live.profit)],
    ['Expectancy', R(all.expectancyR), R(live.expectancyR)],
    ['Profit factor (pips)', all.profitFactor === null ? '–' : num(all.profitFactor, 2), live.profitFactor === null ? '–' : num(live.profitFactor, 2)],
    [t('Max drawdown (nilai)', 'Max drawdown (amount)'), fmtMoney(all.maxDrawdown), fmtMoney(live.maxDrawdown)],
    ['Max drawdown (%)', pct(all.maxDrawdownPct), pct(live.maxDrawdownPct)],
    [t('Kalah beruntun', 'Losing streak'), String(all.consecutiveLoss.byTrade.count), String(live.consecutiveLoss.byTrade.count)],
    [t('Total trade', 'Total trades'), String(all.trades), String(live.trades)],
    [t('Posisi bersamaan maks', 'Max concurrent positions'), String(all.peakOpen), String(live.peakOpen)],
  ];
  return (
    <div className="compare">
      <p className="muted">
        {t('Mengecualikan:', 'Excluding:')} <b>{off.join(', ')}</b>{t('. Balance dan ukuran risiko dihitung ulang tanpa pair itu.', '. Balance and risk size are recalculated without those pairs.')}
      </p>
      <table className="orders tabular">
        <thead>
          <tr>
            <th />
            <th className="num">{t('Semua pair', 'All pairs')}</th>
            <th className="num">{t('Pair aktif', 'Active pairs')}</th>
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
  const t = useT();
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
        {t('Kualitas tiap pair dari hasil run yang sama', 'Quality of each pair from the same run')}
        {net ? t(', setelah spread dan slippage (net)', ', after spread and slippage (net)') : t(', tanpa biaya (gross)', ', without costs (gross)')}
        {t(
          '. Nilai: Bagus = expectancy ≥ 0,15R dan profit factor ≥ 1,3; Cukup = positif; Lemah = rugi; di bawah 30 trade tidak dinilai. Klik pair untuk lihat ringkasannya. Hilangkan centang untuk mengecualikan pair dari perhitungan (hanya backtest; tidak mengubah trading live).',
          '. Grade: Good = expectancy ≥ 0.15R and profit factor ≥ 1.3; Fair = positive; Weak = losing; under 30 trades is not graded. Click a pair to see its summary. Untick to exclude a pair from the calculation (backtest only; does not change live trading).',
        )}
      </p>
      <div className="modal-tools">
        <span className="muted">
          {t(`${activeCount} dari ${pairs.length} pair aktif`, `${activeCount} of ${pairs.length} pairs active`)}
        </span>
        <button type="button" onClick={() => onSet(worst)} disabled={!worst.length}>
          {t(`Buang ${worst.length} terbawah`, `Drop bottom ${worst.length}`)}
        </button>
        <button type="button" onClick={() => onSet([])} disabled={activeCount === pairs.length}>
          {t('Pilih semua', 'Select all')}
        </button>
      </div>
      <div className="table-scroll">
        <table className="orders tabular">
          <thead>
            <tr>
              <th aria-label={t('Ikut dihitung', 'Included')} />
              {th('symbol', 'Pair', false)}
              <th>{t('Nilai', 'Grade')}</th>
              {th('trades', t('Trade', 'Trades'))}
              {th('winRate', 'Win')}
              {th('profitFactor', 'PF')}
              {th('expectancyR', net ? 'Exp. net' : 'Expectancy')}
              {net && th('grossR', 'Exp. gross')}
              {net && th('costR', t('Biaya/trade', 'Cost/trade'))}
              {th('pips', 'Pips')}
              {th('profit', 'Profit')}
              {th('maxDrawdownR', 'DD (R)')}
              {th('maxLossStreak', t('Kalah beruntun', 'Loss streak'))}
              {th('perYear', t('Trade/th', 'Trades/yr'))}
              <th className="num">Data</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.symbol} className={p.active ? 'clickable' : 'clickable off'} onClick={() => p.active && onPick(p.symbol)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={p.active} disabled={p.active && activeCount === 1} onChange={() => onToggle(p.symbol)} aria-label={t(`Hitung ${p.symbol}`, `Include ${p.symbol}`)} />
                </td>
                <td>
                  <b>{p.symbol}</b>
                </td>
                <td>
                  <span className={`grade grade-${p.grade}`}>{gradeLabel(p.grade)}</span>
                </td>
                <td className="num">{p.trades}</td>
                <td className="num">{p.winRate === null ? '–' : pct(p.winRate * 100, 0)}</td>
                <td className="num">{p.profitFactor === null ? '–' : num(p.profitFactor, 2)}</td>
                <td className={`num ${sign(p.expectancyR)}`}>{fmtR(p.expectancyR)}</td>
                {net && <td className={`num muted`}>{fmtR(p.grossR)}</td>}
                {net && (
                  <td className="num" title={p.grossR && p.costR !== null ? t(`${pct((-p.costR / p.grossR) * 100, 0)} dari edge gross`, `${pct((-p.costR / p.grossR) * 100, 0)} of gross edge`) : undefined}>
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
                  {fmtYears(p.years)} <span className="muted">({tierLabel(p.tier)})</span>
                  {p.gapDays > 0 && (
                    <span className="error" title={t(`${p.gapDays} hari tanpa candle di rentang uji`, `${p.gapDays} days without candles in the test range`)}>
                      {' '}
                      {t(`⚠ bolong ${Math.round(p.gapDays / 30)} bln`, `⚠ ${Math.round(p.gapDays / 30)} mo gap`)}
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
  const t = useT();
  const [balance, setBalance] = useState('6000');
  const [risk, setRisk] = useState('1');
  // what the numbers are computed with: the inputs once valid, a moment after typing stops
  const [money, setMoney] = useState({ balance: 6000, riskPct: 1 });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(lastMonthEnd);
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
  // orders costing more than this many R of their own risk are left out of a run; 0 = none
  const costFilter = costs.enabled ? costs.maxCostR : 0;
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
        setTo(ui.to && ui.to <= lastMonthEnd() ? ui.to : lastMonthEnd());
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
      setError(t('Balance dan risk harus lebih dari 0', 'Balance and risk must be greater than 0'));
      return;
    }
    // an empty or later "Sampai" ends on the last day of last month
    const end = lastMonthEnd();
    const runTo = !to || to > end ? end : to;
    setTo(runTo);
    if (from && from > runTo) {
      setError(t('Tanggal "Dari" harus sebelum "Sampai"', 'The "From" date must be before "To"'));
      return;
    }
    worker.current?.terminate();
    setError(null);
    setSavedMsg(null);
    setPhase('loading');
    try {
      const { sr, symbols } = await api.backtestCandles();
      const runFrom = from;
      const w = new Worker(new URL('../backtest.worker.ts', import.meta.url), { type: 'module' });
      worker.current = w;
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === 'progress') setProgress({ done: m.done, total: m.total });
        else if (m.type === 'done') {
          const names = new Set(m.run.coverage.map((c) => c.symbol));
          setResult({ raw: toRaw(m.run.trades), coverage: m.run.coverage, warmup: m.run.warmup, sr, maxCostR: costFilter, from: runFrom, to: runTo, fingerprint: fingerprintOf(symbols) });
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
        setError(e.message || t('Worker gagal', 'Worker failed'));
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
        costs,
        ...(from ? { from: Date.parse(`${from}T00:00:00Z`) } : {}),
        to: Date.parse(`${runTo}T00:00:00Z`),
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
  // spread + commission per pair, for the footnote
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
    const name = `backtest-${symbol === 'ALL' ? tr('semua-pair', 'all-pairs') : symbol}${detail ? '-detail' : ''}.csv`;
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
        ...(result.maxCostR ? { maxCostR: result.maxCostR } : {}),
        coverage: result.coverage,
        fingerprint: result.fingerprint,
        trades: result.raw.map(pack),
      });
      setResult({ ...result, saved: { id: backtest.id, name: backtest.name } });
      setSaveName('');
      await refreshSaved();
      return t(`Tersimpan sebagai "${backtest.name}"`, `Saved as "${backtest.name}"`);
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
        ...(b.maxCostR ? { maxCostR: b.maxCostR } : {}),
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
      return t(`Nama diganti jadi "${backtest.name}"`, `Renamed to "${backtest.name}"`);
    });

  const deleteSaved = () =>
    withSaved(async () => {
      if (!result?.saved || !window.confirm(t(`Hapus hasil tersimpan "${result.saved.name}"? Hasil yang tampil sekarang tetap ada di browser ini.`, `Delete the saved result "${result.saved.name}"? The result shown now stays in this browser.`))) return;
      await api.deleteBacktest(result.saved.id);
      const { saved: _gone, ...rest } = result;
      setResult(rest);
      await refreshSaved();
      return t('Hasil tersimpan dihapus', 'Saved result deleted');
    });

  const cov = result?.coverage ?? [];
  const minYears = cov.length ? Math.min(...cov.map((c) => c.years)) : 0;
  const gapPairs = cov.filter((c) => c.gapDays > 0);
  const shortPairs = cov.filter((c) => c.tier === 'short' || c.tier === 'none');
  const tabs: [Tab, string][] = [['overall', 'Overall'], ['month', 'Per Month'], ['growth', 'Growth'], ['chart', 'Chart'], ['pairs', 'Pair']];
  const busy = phase === 'loading' || phase === 'running';
  const datesChanged = !!result && (from !== result.from || to !== result.to);
  const srChanged = !!result && !!currentSr && !sameSr(result.sr, currentSr);
  const costFilterChanged = !!result && (result.maxCostR ?? 0) !== costFilter;
  const chartData = symbol === 'ALL' ? undefined : candles?.find((s) => s.name === symbol);
  const range = (a: string, b: string) => `${a || t('awal data', 'start of data')} – ${b || t('candle terakhir', 'last candle')}`;

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
          {t('Dari', 'From')} <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          {t('Sampai', 'To')} <input type="date" value={to} min={from || undefined} max={lastMonthEnd()} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
          {busy ? t('Memproses…', 'Processing…') : t('Jalankan', 'Run')}
        </button>
      </div>
      <div className="chips" role="group" aria-label={t('Rentang cepat', 'Quick ranges')}>
        {ranges().map((r) => {
          const [f, to2] = r.range();
          return (
            <button
              key={r.label}
              type="button"
              title={r.title}
              className={f === from && to2 === to ? 'chip active' : 'chip'}
              onClick={() => {
                setFrom(f);
                setTo(to2);
              }}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <p className="muted">
        {t(
          `Compounding: tiap trade berisiko ${risk || '…'}% dari balance saat fill (hanya trade yang sudah close sebelum hari itu). Semua pair aktif, satu balance. Memakai garis S/R terkunci dan pengaturan strategi yang tersimpan. Dihitung di browser Anda; server hanya mengirim candle. Balance dan risk langsung dihitung ulang; Jalankan hanya perlu bila tanggal, pengaturan strategi, atau batas biaya berubah.`,
          `Compounding: each trade risks ${risk || '…'}% of the balance at fill (only trades that closed before that day count). All active pairs, one balance. Uses the fixed S/R lines and the saved strategy settings. Calculated in your browser; the server only sends candles. Balance and risk recalculate instantly; Run is only needed when the dates, strategy settings or cost limit change.`,
        )}
      </p>
      <div className="modal-tools saved-bar">
        <label className="inline">
          {t('Hasil tersimpan', 'Saved results')}{' '}
          <select value={result?.saved?.id ?? ''} onChange={(e) => void openSaved(e.target.value)} disabled={savedBusy || busy} aria-label={t('Hasil tersimpan', 'Saved results')}>
            <option value="">{saved.length ? t('— pilih —', '— select —') : t('— belum ada —', '— none yet —')}</option>
            {saved.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {t(`${s.tradeCount} trade`, `${s.tradeCount} ${s.tradeCount === 1 ? 'trade' : 'trades'}`)} · {range(s.from ?? '', s.to ?? '')}
                {currentSr && !sameSr(s.sr as unknown as SrParams, currentSr) ? t(' · S/R beda', ' · different S/R') : ''}
              </option>
            ))}
          </select>
        </label>
        {result && (
          <>
            <input type="text" placeholder={t('Nama hasil', 'Result name')} maxLength={80} value={saveName} onChange={(e) => setSaveName(e.target.value)} aria-label={t('Nama hasil', 'Result name')} />
            <button type="button" onClick={() => void storeResult()} disabled={savedBusy || busy || !saveName.trim()}>
              {t('Simpan', 'Save')}
            </button>
            {result.saved && (
              <>
                <button type="button" onClick={() => void renameSaved()} disabled={savedBusy || !saveName.trim()} title={t(`Ganti nama "${result.saved.name}" jadi nama di kolom`, `Rename "${result.saved.name}" to the name in the field`)}>
                  {t('Ganti nama', 'Rename')}
                </button>
                <button type="button" onClick={() => void deleteSaved()} disabled={savedBusy}>
                  {t('Hapus', 'Delete')}
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
          {t('Mengunduh candle dari server…', 'Downloading candles from the server…')}
        </p>
      )}
      {phase === 'running' && (
        <p className="muted" role="status">
          {t(`Memproses pair ${progress.done}/${progress.total}…`, `Processing pair ${progress.done}/${progress.total}…`)}
        </p>
      )}

      {result && view && !busy && (
        <>
          <p className="muted">
            {result.saved ? (
              <>
                {t('Hasil tersimpan', 'Saved result')} <b>{result.saved.name}</b>
              </>
            ) : (
              t('Hasil terakhir', 'Last result')
            )}
            {t(`: rentang ${range(result.from, result.to)}, ${result.raw.length} trade.`, `: range ${range(result.from, result.to)}, ${result.raw.length} ${result.raw.length === 1 ? 'trade' : 'trades'}.`)}
            {datesChanged && (
              <span className="error">
                {t(
                  ` Tanggal sudah diubah: klik Jalankan untuk menghitung rentang ${range(from, !to || to > lastMonthEnd() ? lastMonthEnd() : to)}.`,
                  ` Dates changed: click Run to calculate the range ${range(from, !to || to > lastMonthEnd() ? lastMonthEnd() : to)}.`,
                )}
              </span>
            )}
          </p>
          {costFilterChanged && (
            <p className="banner-warn">
              {t(
                `Hasil ini memakai batas biaya ${result!.maxCostR ? `${num(result!.maxCostR, 2)}R` : 'tanpa batas'}, pengaturan sekarang ${costFilter ? `${num(costFilter, 2)}R` : 'tanpa batas'}. Klik Jalankan untuk menghitung ulang.`,
                `This result used a cost limit of ${result!.maxCostR ? `${num(result!.maxCostR, 2)}R` : 'no limit'}, the current setting is ${costFilter ? `${num(costFilter, 2)}R` : 'no limit'}. Click Run to recalculate.`,
              )}
            </p>
          )}
          {srChanged && <p className="banner-warn">{t('Hasil ini memakai pengaturan yang berbeda dari pengaturan sekarang. Klik Jalankan untuk menghitung ulang dengan pengaturan sekarang.', 'This result used different settings from the current ones. Click Run to recalculate with the current settings.')}</p>}
          {(minYears < 2 || shortPairs.length > 0) && (
            <p className="banner-warn">
              {t(`Data teruji hanya ${fmtYears(minYears)}`, `Tested data covers only ${fmtYears(minYears)}`)}
              {shortPairs.length === cov.length ? t(' di semua pair', ' in all pairs') : t(` di ${shortPairs.map((c) => c.symbol).join(', ')}`, ` in ${shortPairs.map((c) => c.symbol).join(', ')}`)}
              {t('. Minimum 2 tahun; 5 / 10 / 20 tahun lebih meyakinkan. Tambah riwayat candle D1 (backfill) dulu sebelum mengandalkan angka ini.', '. Minimum 2 years; 5 / 10 / 20 years is more convincing. Add D1 candle history (backfill) before relying on these numbers.')}
            </p>
          )}
          {gapPairs.length > 0 && (
            <p className="banner-warn">
              {t('Ada lubang di riwayat candle:', 'Gaps in the candle history:')}{' '}
              {gapPairs
                .map((c) => `${c.symbol} ${c.gaps.slice(0, 2).map((g) => `${isoDay(g.from)} → ${isoDay(g.to)}`).join(', ')}${c.gaps.length > 2 ? ', …' : ''}`)
                .join(' · ')}
              {t('. Trade tidak dibuat di hari yang hilang dan garis S/R di sekitarnya kurang akurat. Lengkapi lewat backfill EA atau CSV.', '. No trades are made on the missing days and nearby S/R lines are less accurate. Fill them in via EA backfill or CSV.')}
            </p>
          )}
          <div className="modal-tools">
            <label className="inline">
              Pair{' '}
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Pair">
                <option value="ALL">{t('Semua pair', 'All pairs')}</option>
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
            <span className="seg" role="group" aria-label={t('Biaya trading', 'Trading costs')}>
              <button type="button" aria-pressed={net} disabled={!costs.enabled} onClick={() => setBasis('net')} title={costs.enabled ? t('Setelah spread dan slippage', 'After spread and slippage') : t('Biaya dimatikan di Pengaturan > Biaya backtest', 'Costs are turned off in Settings > Backtest costs')}>
                Net
              </button>
              <button type="button" aria-pressed={!net} onClick={() => setBasis('gross')} title={t('Tanpa spread, komisi, dan slippage', 'Without spread, commission and slippage')}>
                Gross
              </button>
            </span>
            <button type="button" onClick={() => save(false)} disabled={!view.trades.length}>
              {t('Unduh CSV', 'Download CSV')}
            </button>
            <button type="button" onClick={() => save(true)} disabled={!view.trades.length}>
              {t('CSV detail', 'Detailed CSV')}
            </button>
          </div>
          {symbol !== 'ALL' && <p className="muted">{t(`Hanya ${symbol}. Profit = bagian pair ini dari run bersama.`, `${symbol} only. Profit = this pair's share of the joint run.`)}</p>}
          {view.baseline && <CompareBox all={view.baseline} live={view.liveAll ?? view.overall} off={[...excluded].sort()} />}

          {tab === 'overall' && <OverallView o={view.overall} initial={view.initial} grossR={view.grossR} />}
          {tab === 'month' && <MonthView pips={view.monthsPips} money={view.monthsMoney} returns={view.monthsPct} counts={view.monthsTrades} scope={symbol} />}
          {tab === 'growth' && <GrowthChart curve={view.curve} scope={symbol} />}
          {tab === 'chart' &&
            (symbol === 'ALL' ? (
              <div className="chips" role="group" aria-label={t('Pilih pair untuk grafik', 'Pick a pair for the chart')}>
                <span className="muted">{t('Grafik butuh satu pair. Pilih:', 'The chart needs one pair. Pick:')}</span>
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
                {chartState.failed === symbol ? t('Candle tidak bisa diambil.', 'Candles could not be fetched.') : t('Mengambil candle…', 'Fetching candles…')}
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
            {t(
              `Candle D1: untuk trade yang entry dan exit-nya satu hari, urutan harga dibaca open-low-high-close (candle naik) atau open-high-low-close (candle turun). ${view.overall.ambiguous} dari ${view.overall.trades} trade (${view.overall.trades ? pct((view.overall.ambiguous / view.overall.trades) * 100, 1) : '–'}) hasilnya berubah bila urutannya terbalik. Jika SL dan TP kena di candle yang sama setelah posisi terbuka, SL dihitung dulu.`,
              `D1 candles: for trades whose entry and exit fall on the same day, the price order is read as open-low-high-close (up candle) or open-high-low-close (down candle). ${view.overall.ambiguous} of ${view.overall.trades} trades (${view.overall.trades ? pct((view.overall.ambiguous / view.overall.trades) * 100, 1) : '–'}) change result if the order is reversed. If SL and TP are both hit in the same candle after the position opens, SL is counted first.`,
            )}{' '}
            {net ? (
              <>
                {t('Angka', 'The')} <b>net</b>
                {t(': tiap trade dikurangi spread', ' figures: each trade is reduced by the spread')}
                {costs.commissionPerLot > 0 ? t(` + komisi USD ${num(costs.commissionPerLot, 0)}/lot`, ` + USD ${num(costs.commissionPerLot, 0)}/lot commission`) : ''}
                {costs.slippagePips > 0 ? t(` + slippage ${num(costs.slippagePips, 1)} pips`, ` + ${num(costs.slippagePips, 1)} pips slippage`) : ''}
                {t(' dalam pips, dan dalam R sebesar biaya / jarak SL trade itu (fill dan exit tetap dari candle bid). Biaya spread + komisi (pips): ', ' in pips, and in R by cost / the SL distance of that trade (fill and exit still come from bid candles). Spread + commission cost (pips): ')}
                {costList}
                {t('. Spread memakai angka "mulai dari" akun Maxrich Premium (terendah, bukan rata-rata nyata); pelebaran saat berita dan rollover tidak dihitung. Ubah di Pengaturan > Biaya backtest.', '. Spread uses the "from" figure of the Maxrich Premium account (the lowest, not the real average); widening around news and rollover is not counted. Change it in Settings > Backtest costs.')}
              </>
            ) : (
              <>
                {t('Angka', 'The')} <b>gross</b>
                {t(': spread, komisi, dan slippage tidak dihitung, jadi hasil lebih optimis dari akun nyata', ' figures: spread, commission and slippage are not counted, so results are more optimistic than a real account')}
                {costs.enabled ? t('; pilih Net untuk hasil setelah spread', '; pick Net for the result after spread') : t(' (biaya dimatikan di Pengaturan > Biaya backtest)', ' (costs are turned off in Settings > Backtest costs)')}.
              </>
            )}{' '}
            {t(`Warm-up ${result.warmup} candle.`, `Warm-up ${result.warmup} ${result.warmup === 1 ? 'candle' : 'candles'}.`)}
          </p>
        </>
      )}
    </Modal>
  );
}
