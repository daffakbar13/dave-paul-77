const dateFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFmt = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

// "10 Mar 2026" (D1 candles are dated in UTC)
export const fmtDate = (ms: number) => dateFmt.format(new Date(ms)).replace('.', '');

export const fmtWib = (iso: string) => `${timeFmt.format(new Date(iso)).replace('.', ':')} WIB`;

export const fmtPrice = (v: number | null | undefined, digits: number) => (v === null || v === undefined ? '–' : v.toFixed(digits));

export const fmtMoney = (v: number | null | undefined) =>
  v === null || v === undefined ? '–' : v.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtLot = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toFixed(2));

export const fmtRr = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `1:${v.toFixed(1)}`);

export function ago(iso: string | null): string {
  if (!iso) return 'belum pernah';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'baru saja';
  if (min < 60) return `${min} mnt lalu`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} jam lalu` : `${Math.round(h / 24)} hari lalu`;
}

export const digitsOf = (symbol: string) => (symbol.startsWith('XAU') ? 2 : symbol.includes('JPY') ? 3 : 5);
