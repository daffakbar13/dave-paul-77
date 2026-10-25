// Draws backtest trades the way MT5's trade history shows them on a chart: an arrow at the
// entry and one at the exit, joined by a dotted line, blue for buys and red for sells. The
// arrow's tip is on the price; the entry points the trade's way, the exit (the closing deal)
// the other way.
// Drawn as one series primitive: thousands of trades as separate series would be slow.
import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, Time, UTCTimestamp } from 'lightweight-charts';
import type { BtTrade } from '../engine/backtestStats.ts';

export const BUY = '#2F7BFF';
export const SELL = '#FF3B30';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
type Point = { trade: BtTrade; x1: number; y1: number; x2: number | null; y2: number | null };

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
export const exitPrice = (t: BtTrade) => (t.result === 'TP' ? t.tp : t.result === 'SL' ? t.sl : null);

// block arrow, white outline, tip at (x, y); `s` scales it (1 = normal size)
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, up: boolean, s: number, color: string) {
  const d = up ? 1 : -1; // up: the body hangs below the tip
  const head = 5 * s; // head height
  const half = 5.5 * s; // head half-width
  const shaft = 2 * s; // shaft half-width
  const tail = 5 * s; // shaft length
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + half, y + d * head);
  ctx.lineTo(x + shaft, y + d * head);
  ctx.lineTo(x + shaft, y + d * (head + tail));
  ctx.lineTo(x - shaft, y + d * (head + tail));
  ctx.lineTo(x - shaft, y + d * head);
  ctx.lineTo(x - half, y + d * head);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();
}

export class TradeHistory implements ISeriesPrimitive<Time> {
  private trades: BtTrade[] = [];
  private focus: string | null = null;
  private keyOf: (t: BtTrade) => string = () => '';
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private points: Point[] = []; // where the last frame drew each trade, for hit tests

  private readonly renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
  private readonly view: IPrimitivePaneView = { renderer: () => this.renderer, zOrder: () => 'top' };

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<'Candlestick'>;
    this.requestUpdate = p.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return [this.view];
  }

  set(trades: BtTrade[], focus: string | null, keyOf: (t: BtTrade) => string) {
    this.trades = trades;
    this.focus = focus;
    this.keyOf = keyOf;
    this.requestUpdate?.();
  }

  // the trade whose entry or exit arrow is under (x, y), nearest first (tip or body)
  hit(x: number, y: number): BtTrade | null {
    let best: BtTrade | null = null;
    let bestD = 8 * 8;
    for (const p of this.points) {
      const buy = p.trade.side === 'buy';
      // arrow bodies: entry below the tip for a buy, exit the other way
      for (const [px, py] of [[p.x1, p.y1 === null ? null : p.y1 + (buy ? 5 : -5)], [p.x2, p.y2 === null ? null : p.y2 + (buy ? -5 : 5)]] as const) {
        if (px === null || py === null) continue;
        const d = (px - x) ** 2 + (py - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p.trade;
        }
      }
    }
    return best;
  }

  private draw(target: Target) {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      const points: Point[] = [];
      for (const trade of this.trades) {
        const x1 = ts.timeToCoordinate(toTime(trade.entryAt));
        const y1 = series.priceToCoordinate(trade.entry);
        if (x1 === null || y1 === null) continue;
        const exit = exitPrice(trade);
        const x2 = trade.exitAt !== null && exit !== null ? ts.timeToCoordinate(toTime(trade.exitAt)) : null;
        const y2 = exit !== null ? series.priceToCoordinate(exit) : null;
        const right = x2 ?? x1;
        if (right < -10 || x1 > mediaSize.width + 10) continue;
        points.push({ trade, x1, y1, x2, y2 });
      }
      // the focused trade last, on top
      const focused = points.filter((p) => this.keyOf(p.trade) === this.focus);
      const ordered = [...points.filter((p) => !focused.includes(p)), ...focused];
      for (const p of ordered) {
        const isFocus = focused.includes(p);
        const color = p.trade.side === 'buy' ? BUY : SELL;
        if (p.x2 !== null && p.y2 !== null) {
          ctx.beginPath();
          ctx.setLineDash(isFocus ? [] : [3, 3]);
          ctx.lineWidth = isFocus ? 2 : 1;
          ctx.strokeStyle = color;
          ctx.moveTo(p.x1, p.y1);
          ctx.lineTo(p.x2, p.y2);
          ctx.stroke();
          ctx.setLineDash([]);
          arrow(ctx, p.x2, p.y2, p.trade.side === 'sell', isFocus ? 1.35 : 1, color);
        }
        arrow(ctx, p.x1, p.y1, p.trade.side === 'buy', isFocus ? 1.35 : 1, color);
      }
      this.points = points;
    });
  }
}
