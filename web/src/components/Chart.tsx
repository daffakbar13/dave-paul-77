import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Analysis, Candle, Colors, OrderRow } from '../api.ts';
import { fmtDate, fmtLot, fmtPrice, fmtRr } from '../format.ts';

type Props = {
  analysis: Analysis;
  colors: Colors;
  focusId: string | null;
  onlyFocused: boolean;
  onFocus: (id: string | null) => void;
  onCancel: (row: OrderRow) => void;
};

type Label = { key: string; rowId: string; kind: 'entry' | 'sl' | 'tp'; y: number; row: OrderRow };

const CANDLE = '#3BD16F';
const CANDLE_BODY_UP = '#EAFBEF';

function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const timeMs = (t: Time) => (typeof t === 'number' ? t * 1000 : 0);

// Orders that get lines on the chart: everything with levels except cancelled ones.
const drawable = (r: OrderRow) => r.entry !== null && r.sl !== null && r.tp !== null && r.status !== 'cancelled' && r.status !== 'skipped';

export function Chart({ analysis, colors, focusId, onlyFocused, onFocus, onCancel }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [hover, setHover] = useState<Candle | null>(null);
  // hover only highlights; a click pins the focus and also shows the SL/TP labels
  const [hoverId, setHoverId] = useState<string | null>(null);
  const active = hoverId ?? focusId;
  const digits = analysis.digits;

  // chart + series live for the component's lifetime
  useEffect(() => {
    const chart = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#000000' }, textColor: '#9AA3AD', fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 12 },
      grid: { vertLines: { color: '#15181C' }, horzLines: { color: '#15181C' } },
      rightPriceScale: { borderColor: '#2A2F36' },
      timeScale: {
        borderColor: '#2A2F36',
        rightOffset: 8,
        tickMarkFormatter: (t: Time) => fmtDate(timeMs(t)),
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: (t: Time) => fmtDate(timeMs(t)) },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: CANDLE_BODY_UP,
      downColor: CANDLE,
      borderUpColor: CANDLE,
      borderDownColor: CANDLE,
      wickUpColor: CANDLE,
      wickDownColor: CANDLE,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chart.subscribeCrosshairMove((p) => {
      const d = p.time !== undefined ? (p.seriesData.get(series) as CandlestickData<Time> | undefined) : undefined;
      setHover(d && 'open' in d ? { t: timeMs(p.time!), o: d.open, h: d.high, l: d.low, c: d.close } : null);
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, []);

  // candles: reset the view only when the symbol changes
  const lastSymbol = useRef<string | null>(null);
  useEffect(() => {
    const series = seriesRef.current!;
    series.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits } });
    series.setData(analysis.candles.map((c) => ({ time: toTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    if (lastSymbol.current !== analysis.symbol) {
      chartRef.current!.timeScale().setVisibleLogicalRange({ from: analysis.candles.length - 120, to: analysis.candles.length + 8 });
      lastSymbol.current = analysis.symbol;
    }
  }, [analysis.candles, analysis.symbol, digits]);

  const orders = useMemo(() => analysis.rows.filter(drawable), [analysis.rows]);
  const visible = useMemo(
    () => (onlyFocused && focusId ? orders.filter((r) => r.id === focusId) : orders),
    [orders, onlyFocused, focusId],
  );

  // price lines: S/R in yellow, entry in white, SL/TP in red; non-focused orders dimmed
  useEffect(() => {
    const series = seriesRef.current!;
    for (const l of linesRef.current) series.removePriceLine(l);
    const created: IPriceLine[] = [];
    const add = (price: number, color: string, style: LineStyle, axis: boolean, width: 1 | 2 = 1) =>
      created.push(series.createPriceLine({ price, color, lineStyle: style, lineWidth: width, axisLabelVisible: axis, title: '' }));

    for (const line of analysis.lines) add(line.price, colors.sr, LineStyle.Solid, false, 2);
    for (const r of visible) {
      const focused = active === r.id;
      const dim = active !== null && !focused;
      const weak = r.status === 'invalid' ? 0.45 : 1;
      add(r.entry!, alpha(colors.entry, (dim ? 0.15 : 1) * weak), LineStyle.Dashed, focused);
      const sltp = alpha(colors.sltp, (dim ? 0.12 : focused ? 1 : 0.4) * weak);
      add(r.sl!, sltp, LineStyle.Dashed, focused);
      add(r.tp!, sltp, LineStyle.Dashed, focused);
    }
    linesRef.current = created;
  }, [analysis.lines, visible, active, colors]);

  // Left-edge labels follow the price scale; recomputed every frame, state updated only
  // when a position changed. Overlapping labels are pushed down.
  useEffect(() => {
    let frame = 0;
    let previous = '';
    const tick = () => {
      const series = seriesRef.current;
      if (series) {
        const next: Label[] = [];
        for (const r of visible) {
          const kinds = focusId === r.id || visible.length === 1 ? (['entry', 'sl', 'tp'] as const) : (['entry'] as const);
          for (const kind of kinds) {
            const y = series.priceToCoordinate(r[kind]!);
            if (y !== null) next.push({ key: `${r.id}-${kind}`, rowId: r.id, kind, y, row: r });
          }
        }
        next.sort((a, b) => a.y - b.y);
        if (next[0]) next[0].y = Math.max(next[0].y, 30); // keep clear of the OHLC header
        for (let i = 1; i < next.length; i++) if (next[i]!.y - next[i - 1]!.y < 17) next[i]!.y = next[i - 1]!.y + 17;
        const sig = next.map((l) => `${l.key}:${Math.round(l.y)}`).join('|');
        if (sig !== previous) {
          previous = sig;
          setLabels(next);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [visible, focusId]);

  const last = analysis.candles[analysis.candles.length - 1];
  const shown = hover ?? last;

  return (
    <div className="chart-wrap">
      <div ref={box} className="chart" />
      <div className="chart-head tabular">
        {analysis.symbol}, Daily
        {shown && (
          <span>
            {' '}{fmtPrice(shown.o, digits)} {fmtPrice(shown.h, digits)} {fmtPrice(shown.l, digits)} {fmtPrice(shown.c, digits)}
          </span>
        )}
      </div>
      <div className="chart-labels">
        {labels.map((l) => {
          const r = l.row;
          const dim = active !== null && active !== r.id;
          if (l.kind !== 'entry') {
            return (
              <div key={l.key} className="chart-label sltp" style={{ top: l.y - 8, color: colors.sltp }}>
                {l.kind}
                {l.kind === 'tp' && r.tpAuto && <span className="tag">TP auto</span>}
              </div>
            );
          }
          return (
            <div
              key={l.key}
              className={`chart-label entry${dim ? ' dim' : ''}${active === r.id ? ' focused' : ''}`}
              style={{ top: l.y - 9 }}
              onMouseEnter={() => setHoverId(r.id)}
              onMouseLeave={() => setHoverId(null)}
              onClick={() => onFocus(focusId === r.id ? null : r.id)}
            >
              <span className="tabular">
                {r.type} {fmtLot(r.lot)}
                {r.multiplier > 1 && <span className="aggr"> {r.multiplier}x</span>}
              </span>
              <span className={`tabular${r.lowRr ? ' low-rr-text' : ''}`}>RR {fmtRr(r.rr)}</span>
              {r.status === 'invalid' && <span className="invalid-text">{r.reason}</span>}
              <button
                type="button"
                className="x"
                aria-label={`Batalkan ${r.type} ${fmtPrice(r.entry, digits)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel(r);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
