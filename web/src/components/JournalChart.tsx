import { BaselineSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineStyle, type Time, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useMemo, useRef } from 'react';
import type { JournalTrade } from '../api.ts';
import { fmtMoney } from '../format.ts';
import { locale, useT } from '../i18n.ts';

const UP = '#3BD16F';
const DOWN = '#FF453A';
const WIB = 7 * 3600; // the chart axis has no time zones: shift seconds so it reads WIB

// The month's equity curve (net summed trade by trade, at each close) over the daily net bars.
export function JournalChart({ trades, currency }: { trades: JournalTrade[]; currency: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);

  const { equity, daily } = useMemo(() => {
    const closed = trades
      .filter((x) => x.status === 'closed' && x.closedAt)
      .map((x) => ({ s: Math.floor(Date.parse(x.closedAt!) / 1000) + WIB, net: x.net }))
      .sort((a, b) => a.s - b.s);
    const equity: { time: UTCTimestamp; value: number }[] = [];
    const days = new Map<number, number>();
    let sum = 0;
    for (const c of closed) {
      sum += c.net;
      const last = equity[equity.length - 1];
      // one point per second: trades closing together collapse into the last sum
      if (last && last.time === c.s) last.value = sum;
      else equity.push({ time: c.s as UTCTimestamp, value: sum });
      const day = c.s - (c.s % 86400);
      days.set(day, (days.get(day) ?? 0) + c.net);
    }
    // start the curve at 0 just before the first close
    if (equity.length) equity.unshift({ time: (equity[0]!.time - 60) as UTCTimestamp, value: 0 });
    const daily = [...days].map(([d, v]) => ({ time: (d + 12 * 3600) as UTCTimestamp, value: v, color: v >= 0 ? 'rgba(59,209,111,0.45)' : 'rgba(255,69,58,0.45)' }));
    return { equity, daily };
  }, [trades]);

  useEffect(() => {
    if (!box.current || !equity.length) return;
    const money = (v: number) => v.toLocaleString(locale(), { maximumFractionDigits: 0 });
    const dt = (tm: Time) =>
      new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(new Date((tm as number) * 1000));
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'rgba(0,0,0,0)' }, textColor: '#9AA3AD', fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.06)', style: LineStyle.Dashed } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.3 } },
      leftPriceScale: { visible: false },
      timeScale: { borderVisible: false, timeVisible: false },
      crosshair: { mode: CrosshairMode.Magnet },
      localization: { timeFormatter: dt, priceFormatter: money },
      handleScroll: false,
      handleScale: false,
    });
    const bars = chart.addSeries(HistogramSeries, { priceScaleId: 'daily', priceLineVisible: false, lastValueVisible: false, title: t('harian', 'daily') });
    chart.priceScale('daily').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });
    bars.setData(daily);
    const line = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: UP,
      topFillColor1: 'rgba(59,209,111,0.28)',
      topFillColor2: 'rgba(59,209,111,0.02)',
      bottomLineColor: DOWN,
      bottomFillColor1: 'rgba(255,69,58,0.02)',
      bottomFillColor2: 'rgba(255,69,58,0.28)',
      lineWidth: 2,
      priceLineVisible: false,
    });
    line.setData(equity);
    line.createPriceLine({ price: 0, color: 'rgba(255,255,255,0.25)', lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: '' });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [equity, daily, t]);

  if (!equity.length) return null;
  const end = equity[equity.length - 1]!.value;
  return (
    <div className="audit-chart">
      <h3>
        {t('Kurva ekuitas', 'Equity curve')} <span className="muted">· net {currency} {fmtMoney(end)}</span>
      </h3>
      <div className="audit-chart-box">
        <div ref={box} role="img" aria-label={t('Kurva ekuitas bulan ini dan net harian', "This month's equity curve and daily net")} />
      </div>
    </div>
  );
}
