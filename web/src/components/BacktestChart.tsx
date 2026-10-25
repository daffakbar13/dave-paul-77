import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BtTrade } from '../engine/backtestStats.ts';
import { analyze } from '../engine/sr.ts';
import type { Candle, SrParams, SymbolInputs } from '../engine/types.ts';
import { fmtDate, fmtMoney, fmtPrice } from '../format.ts';
import { BUY, exitPrice, SELL, TradeHistory } from './tradeHistory.ts';

type Props = { symbol: string; digits: number; candles: number[][]; inputs: SymbolInputs; sr: SrParams; trades: BtTrade[] };

// same MT4 look as the main chart
const CANDLE = '#00FF00';
const TP = '#3BD16F';
const SL = '#FF453A';
const SR = '#FFD60A'; // the main chart's default S/R colour

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const timeMs = (t: Time) => (typeof t === 'number' ? t * 1000 : 0);
// trades are rebuilt when balance or risk changes; this stays the same
const keyOf = (t: BtTrade) => `${t.symbol}-${t.entryAt}-${t.side}-${t.entry}`;

// first candle at or after `ms`
function barIndex(candles: number[][], ms: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]![0]! < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// D1 candles of one pair with every simulated trade drawn like MT5's trade history: entry
// and exit arrows joined by a dotted line, blue for buys, red for sells. Hover an arrow
// for the details; click it (or a row of the table) to pick the trade.
export function BacktestChart({ symbol, digits, candles, inputs, sr, trades }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const historyRef = useRef<TradeHistory | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; trade: BtTrade } | null>(null);
  const focus = useMemo(() => trades.find((t) => keyOf(t) === focusKey) ?? null, [trades, focusKey]);
  const [showSr, setShowSr] = useState(true);
  const [edge, setEdge] = useState(candles.length - 1); // right-most candle in view
  const bars = useMemo<Candle[]>(() => candles.map(([t, o, h, l, c]) => ({ t: t!, o: o!, h: h!, l: l!, c: c! })), [candles]);

  // S/R as the engine drew it on the morning of one day (from the candles closed before it,
  // the run's settings): the picked trade's entry day, else the last day in view. The
  // replay places that day's orders from exactly these lines.
  const srDay = focus ? barIndex(candles, focus.entryAt) : edge;
  const srAnalysis = useMemo(
    () => (showSr && srDay > 0 ? analyze(symbol, bars.slice(Math.max(0, srDay - sr.lookback), srDay), sr, digits, undefined, inputs) : null),
    [showSr, srDay, bars, symbol, sr, digits, inputs],
  );
  // the line the picked trade's order was built on
  const tradeLine = useMemo(
    () => (focus && srAnalysis ? srAnalysis.candidates.find((c) => c.side === focus.side && c.entry === focus.entry)?.line ?? null : null),
    [focus, srAnalysis],
  );

  useEffect(() => {
    const chart = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#000000' }, textColor: '#9AA3AD', fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 12 },
      grid: { vertLines: { color: '#3A3F46', style: LineStyle.Dashed }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: '#2A2F36' },
      timeScale: { borderColor: '#2A2F36', rightOffset: 4, tickMarkFormatter: (t: Time) => fmtDate(timeMs(t)) },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: (t: Time) => fmtDate(timeMs(t)) },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: 'rgba(0, 0, 0, 0)',
      downColor: '#FFFFFF',
      borderUpColor: CANDLE,
      borderDownColor: CANDLE,
      wickUpColor: CANDLE,
      wickDownColor: CANDLE,
      priceLineVisible: false,
      priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits },
    });
    series.setData(candles.map(([t, o, h, l, c]) => ({ time: toTime(t!), open: o!, high: h!, low: l!, close: c! })));
    const history = new TradeHistory();
    series.attachPrimitive(history);
    chart.subscribeCrosshairMove((p) => {
      const trade = p.point ? history.hit(p.point.x, p.point.y) : null;
      setHover(trade && p.point ? { x: p.point.x, y: p.point.y, trade } : null);
    });
    chart.subscribeClick((p) => {
      const trade = p.point ? history.hit(p.point.x, p.point.y) : null;
      if (trade) setFocusKey((k) => (k === keyOf(trade) ? null : keyOf(trade)));
    });
    let timer = 0;
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      window.clearTimeout(timer);
      if (r) timer = window.setTimeout(() => setEdge(Math.max(0, Math.min(candles.length - 1, Math.floor(r.to)))), 150);
    });
    chart.timeScale().setVisibleLogicalRange({ from: candles.length - 120, to: candles.length + 4 });
    chartRef.current = chart;
    seriesRef.current = series;
    historyRef.current = history;
    return () => {
      window.clearTimeout(timer);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      historyRef.current = null;
    };
  }, [candles, digits]);

  useEffect(() => {
    historyRef.current?.set(trades, focusKey, keyOf);
  }, [trades, focusKey, candles, digits]);

  // a picked trade: its entry / SL / TP as lines
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !focus) return;
    const lines: IPriceLine[] = [
      series.createPriceLine({ price: focus.entry, color: focus.side === 'buy' ? BUY : SELL, lineStyle: LineStyle.Solid, lineWidth: 1, axisLabelVisible: true, title: 'entry' }),
      series.createPriceLine({ price: focus.tp, color: TP, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: 'TP' }),
      series.createPriceLine({ price: focus.sl, color: SL, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: 'SL' }),
    ];
    return () => {
      // the chart may be gone already (new candles)
      if (seriesRef.current === series) for (const l of lines) series.removePriceLine(l);
    };
  }, [focus, candles, digits]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !srAnalysis) return;
    const lines = srAnalysis.lines.map((l) =>
      series.createPriceLine({
        price: l.price,
        color: SR,
        lineStyle: LineStyle.Solid,
        lineWidth: l.price === tradeLine || l.source === 'manual' ? 2 : 1,
        axisLabelVisible: l.price === tradeLine,
        title: l.price === tradeLine ? 'S/R trade' : '',
      }),
    );
    return () => {
      if (seriesRef.current === series) for (const l of lines) series.removePriceLine(l);
    };
  }, [srAnalysis, tradeLine, candles, digits]);

  // ...and centred, only when another trade is picked (not when balance or risk changes)
  const centreOn = (t: BtTrade) => {
    // by bar index: a time range past the last candle gets clamped and misses recent trades
    const a = barIndex(candles, t.entryAt);
    const b = barIndex(candles, t.exitAt ?? t.entryAt);
    const pad = Math.max(30, (b - a) * 2);
    chartRef.current?.timeScale().setVisibleLogicalRange({ from: a - pad, to: b + pad });
  };

  const recent = useMemo(() => [...trades].sort((a, b) => b.entryAt - a.entryAt), [trades]);
  const h = hover?.trade;
  const hExit = h ? exitPrice(h) : null;

  return (
    <>
      <div className="modal-tools">
        <span className="muted">
          {symbol} D1 · {trades.length} trade. <span style={{ color: BUY }}>⬆ buy</span> / <span style={{ color: SELL }}>⬇ sell</span>: entry ke exit, garis putus-putus seperti riwayat trade
          MT5. Arahkan ke panah untuk detail, klik untuk menandai.
        </span>
        <label className="inline">
          <input type="checkbox" checked={showSr} onChange={(e) => setShowSr(e.target.checked)} /> S/R
        </label>
        {showSr && srAnalysis && candles[srDay] && (
          <span className="muted">
            <span style={{ color: SR }}>━</span> {srAnalysis.lines.length} garis S/R engine, pagi {fmtDate(candles[srDay]![0]!)}
            {focus ? ' (hari entry trade terpilih' + (tradeLine === null ? ')' : '; garis tebal = dasar order-nya)') : ' (candle terakhir yang terlihat)'}
          </span>
        )}
      </div>
      <div className="bt-chart-wrap">
        <div ref={box} className="bt-chart" role="img" aria-label={`Grafik ${symbol} dengan trade backtest`} />
        {h && hover && (
          <div className="bt-tip tabular" style={{ left: hover.x > (box.current?.clientWidth ?? 0) - 240 ? hover.x - 230 : hover.x + 14, top: hover.y + 14 }}>
            <b style={{ color: h.side === 'buy' ? BUY : SELL }}>{h.side === 'buy' ? 'Buy' : 'Sell'}</b> {fmtPrice(h.entry, h.digits)} · {fmtDate(h.entryAt)}
            <br />
            <span className={h.result === 'TP' ? 'ok' : 'error'}>{h.result}</span> {fmtPrice(hExit, h.digits)} · {h.exitAt === null ? '' : fmtDate(h.exitAt)}
            <br />
            {h.pips.toLocaleString('id-ID', { maximumFractionDigits: 1 })} pips · {fmtMoney(h.profit)}
            {h.ambiguous ? ' · urutan intraday ambigu' : ''}
          </div>
        )}
      </div>
      <div className="table-scroll bt-trades">
        <table className="orders tabular">
          <thead>
            <tr>
              <th>Entry</th>
              <th>Exit</th>
              <th>Arah</th>
              <th className="num">Entry</th>
              <th className="num">TP</th>
              <th className="num">SL</th>
              <th>Hasil</th>
              <th className="num">Pips</th>
              <th className="num">Profit</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((t) => (
              <tr key={keyOf(t)} className={focusKey === keyOf(t) ? 'clickable focused' : 'clickable'} onClick={() => {
                  const next = focusKey === keyOf(t) ? null : keyOf(t);
                  setFocusKey(next);
                  if (next) centreOn(t);
                }}>
                <td>{fmtDate(t.entryAt)}</td>
                <td>{fmtDate(t.exitAt!)}</td>
                <td>{t.side === 'buy' ? 'Buy' : 'Sell'}</td>
                <td className="num">{fmtPrice(t.entry, t.digits)}</td>
                <td className="num">{fmtPrice(t.tp, t.digits)}</td>
                <td className="num">{fmtPrice(t.sl, t.digits)}</td>
                <td className={t.result === 'TP' ? 'ok' : t.result === 'SL' ? 'error' : ''}>
                  {t.result}
                  {t.ambiguous ? ' *' : ''}
                </td>
                <td className="num">{t.pips.toLocaleString('id-ID', { maximumFractionDigits: 1 })}</td>
                <td className="num">{fmtMoney(t.profit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
