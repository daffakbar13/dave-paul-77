// Reads D1 candles out of a price-history CSV, to fill years the MT4 terminal does not
// have. Accepts the usual exports (MT4 History Center, HistData, Dukascopy, TradingView):
// delimiter , ; or tab, optional header, a date or date + time, then open high low close.
// Intraday files (H1, M15, ...) are folded into days.
import { roundTo } from './sr.ts';

export type DayCandle = { t: number; o: number; h: number; l: number; c: number }; // t = seconds, UTC midnight

export type ParseResult = { candles: DayCandle[]; rows: number; skipped: number; weekends: number; error?: string };

const DAY = 86_400;

// 2020.01.02 | 2020-01-02 | 2020/01/02 | 20200102 | 02.01.2020 | 2020-01-02T10:00:00
function parseDate(field: string): number | null {
  const f = field.trim();
  let m = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(f);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})(?!\d)/.exec(f);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  const d = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/.exec(f);
  if (d) return Date.UTC(Number(d[3]), Number(d[2]) - 1, Number(d[1])) / 1000;
  return null;
}

const isTime = (f: string) => /^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/.test(f.trim()) || /^\d{6}$/.test(f.trim());
const toNum = (f: string | undefined) => (f === undefined || f.trim() === '' ? NaN : Number(f.trim().replace(/^"|"$/g, '')));

export function parseCandleCsv(text: string, opts: { weekends?: boolean; from?: number; until?: number } = {}): ParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const days = new Map<number, DayCandle>();
  let rows = 0;
  let skipped = 0;
  let weekends = 0;
  for (const line of lines) {
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const t = parseDate(cells[0] ?? '');
    if (t === null) {
      skipped++; // header or junk
      continue;
    }
    // a time column may follow the date
    const base = cells.length > 1 && isTime(cells[1] ?? '') ? 2 : 1;
    const [o, h, l, c] = [toNum(cells[base]), toNum(cells[base + 1]), toNum(cells[base + 2]), toNum(cells[base + 3])];
    if (![o, h, l, c].every((v) => Number.isFinite(v) && v > 0) || h! < Math.max(o!, c!, l!) - 1e-9 || l! > Math.min(o!, c!) + 1e-9) {
      skipped++;
      continue;
    }
    rows++;
    if (opts.from !== undefined && t < opts.from) continue;
    if (opts.until !== undefined && t > opts.until) continue;
    const dow = new Date(t * 1000).getUTCDay();
    if (!opts.weekends && (dow === 0 || dow === 6)) {
      weekends++;
      continue;
    }
    const day = days.get(t);
    if (!day) days.set(t, { t, o: o!, h: h!, l: l!, c: c! });
    else {
      // rows come oldest first within a day; a later row extends the day
      day.h = Math.max(day.h, h!);
      day.l = Math.min(day.l, l!);
      day.c = c!;
    }
  }
  const candles = [...days.values()].sort((a, b) => a.t - b.t).map((d) => ({ t: d.t, o: roundTo(d.o, 8), h: roundTo(d.h, 8), l: roundTo(d.l, 8), c: roundTo(d.c, 8) }));
  const base = { candles, rows, skipped, weekends };
  return candles.length ? base : { ...base, error: 'Tidak ada baris candle yang terbaca' };
}

// Midnight UTC of a YYYY-MM-DD, in seconds.
export function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000;
}

export const DAY_SECONDS = DAY;
