import { TickMarkType } from 'lightweight-charts';
import { locale, tr } from './i18n.ts';

// Formatters per language, built on first use.
const cache = new Map<string, Intl.DateTimeFormat>();
const fmt = (name: string, opts: Intl.DateTimeFormatOptions) => {
  const key = `${locale()}:${name}`;
  let f = cache.get(key);
  if (!f) cache.set(key, (f = new Intl.DateTimeFormat(locale(), opts)));
  return f;
};
const dateFmt = () => fmt('date', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFmt = () => fmt('time', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Jakarta' });

// "10 Mar 2026" (D1 candles are dated in UTC)
export const fmtDate = (ms: number) => dateFmt().format(new Date(ms)).replace('.', '');

// A candle's open time: the date for D1, date and hour for H4 ("10 Mar 2026 08:00"), on the
// broker clock like the dates.
export const fmtCandle = (ms: number, tf: 'D1' | 'H4' = 'D1') => {
  if (tf === 'D1') return fmtDate(ms);
  const d = new Date(ms);
  return `${fmtDate(ms)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

// Chart axis labels: dates, plus the hour on H4 where the axis marks a time inside a day.
export function tickLabel(ms: number, type: TickMarkType, tf: 'D1' | 'H4'): string {
  if (tf === 'H4' && type >= TickMarkType.Time) {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
  return fmtDate(ms);
}

export const fmtWib = (iso: string) => `${timeFmt().format(new Date(iso)).replace('.', ':')} WIB`;

const dateTimeFmt = () => fmt('dateTime', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Jakarta' });

// "3 Nov 15:00" in WIB
export const fmtWibDateTime = (iso: string | null) => (iso ? dateTimeFmt().format(new Date(iso)).replace('.', ':').replace(',', '') : '–');

const dayFmt = () => fmt('day', { weekday: 'short', timeZone: 'Asia/Jakarta' });
const wibDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);

// "19:30 WIB" today, "Kam 19:30 WIB" / "Thu 19:30 WIB" on another day
export function fmtNewsTime(iso: string): string {
  const d = new Date(iso);
  const day = wibDay(d) === wibDay(new Date()) ? '' : `${dayFmt().format(d)} `;
  return `${day}${fmtWib(iso)}`;
}

export const fmtPrice = (v: number | null | undefined, digits: number) => (v === null || v === undefined ? '–' : v.toFixed(digits));

export const fmtMoney = (v: number | null | undefined) =>
  v === null || v === undefined ? '–' : v.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtLot = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toFixed(2));

export const fmtRr = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `1:${v.toFixed(1)}`);

export function ago(iso: string | null): string {
  if (!iso) return tr('belum pernah', 'never');
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return tr('baru saja', 'just now');
  if (min < 60) return tr(`${min} mnt lalu`, `${min} min ago`);
  const h = Math.round(min / 60);
  if (h < 48) return tr(`${h} jam lalu`, `${h} h ago`);
  return tr(`${Math.round(h / 24)} hari lalu`, `${Math.round(h / 24)} days ago`);
}

export const digitsOf = (symbol: string) => (symbol.startsWith('XAU') ? 2 : symbol.includes('JPY') ? 3 : 5);
