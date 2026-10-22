// ForexFactory weekly feed, fetched at most every 4 hours and kept in KV. Every other
// reader (the alert runs, the Render server) uses the kept copy, so the feed sees about
// six requests a day from here and none from Render.
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

// Same data in two formats, rate-limited separately per address. The JSON one is what
// everyone polls, so from Cloudflare's shared IPs it is nearly always limited; the XML
// one usually answers. XML first, JSON when XML is limited or broken.
const XML_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const JSON_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const REFRESH_EVERY = 4 * HOUR;
const RETRY_AFTER_ERROR = 30 * MINUTE;
const RETRY_AFTER_LIMIT = HOUR; // when the feed rate-limits without saying for how long

export type Impact = 'high' | 'medium' | 'low';
export type NewsItem = { at: string; currency: string; impact: Impact; title: string };

export type Calendar = {
  items: NewsItem[];
  fetchedAt: string | null; // last successful fetch
  attemptedAt: string | null;
  error: string | null;
  retryAt: string | null; // no fetch before this (rate limit backoff)
};

export const EMPTY_CALENDAR: Calendar = { items: [], fetchedAt: null, attemptedAt: null, error: null, retryAt: null };

export class RateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`rate limit, coba lagi setelah ${Math.ceil(retryAfterMs / MINUTE)} menit`);
    this.retryAfterMs = retryAfterMs;
  }
}

const IMPACT: Record<string, Impact> = { High: 'high', Medium: 'medium', Low: 'low' };

// Same rules as the server's parser: holidays and malformed rows are dropped. Unlike the
// server, any currency is kept ("All" included); the alerts filter on impact only.
export function parseForexFactory(raw: unknown): NewsItem[] {
  if (!Array.isArray(raw)) throw new Error('Format kalender tidak dikenal');
  const out: NewsItem[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const impact = IMPACT[String(r.impact)];
    const currency = String(r.country ?? '').toUpperCase();
    const at = new Date(String(r.date));
    if (!impact || !/^[A-Z]{3}$/.test(currency) || Number.isNaN(at.getTime())) continue;
    out.push({ at: at.toISOString(), currency, impact, title: String(r.title ?? '').slice(0, 200) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlField(event: string, name: string): string {
  const m = event.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
  return (m?.[1] ?? '').trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e] ?? '');
}

// The XML feed: date MM-DD-YYYY and time like "8:30am", both in UTC (unlike the JSON
// feed's New York offset). Rows without a clock time ("All Day", "Tentative") are dropped.
export function parseForexFactoryXml(xml: string): NewsItem[] {
  if (!xml.includes('<weeklyevents')) throw new Error('Format kalender tidak dikenal');
  const out: NewsItem[] = [];
  for (const [, ev = ''] of xml.matchAll(/<event>([\s\S]*?)<\/event>/g)) {
    const impact = IMPACT[xmlField(ev, 'impact')];
    const currency = xmlField(ev, 'country').toUpperCase();
    const d = xmlField(ev, 'date').match(/^(\d{2})-(\d{2})-(\d{4})$/);
    const t = xmlField(ev, 'time').match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
    if (!impact || !/^[A-Z]{3}$/.test(currency) || !d || !t) continue;
    const hour = (Number(t[1]) % 12) + (t[3]!.toLowerCase() === 'pm' ? 12 : 0);
    const at = new Date(Date.UTC(Number(d[3]), Number(d[1]) - 1, Number(d[2]), hour, Number(t[2])));
    out.push({ at: at.toISOString(), currency, impact, title: xmlField(ev, 'title').slice(0, 200) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

async function fetchText(url: string, accept: string, fetcher: typeof fetch): Promise<string> {
  const res = await fetcher(url, {
    headers: { 'User-Agent': 'DavePaul77-Worker/1.0', Accept: accept },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    const secs = Number(res.headers.get('retry-after'));
    throw new RateLimitError(secs > 0 ? secs * 1000 : RETRY_AFTER_LIMIT);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // The XML is windows-1252: read bytes as Latin-1 (the same for every title character
  // the feed uses) instead of relying on a non-UTF-8 TextDecoder.
  const bytes = new Uint8Array(await res.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  // When limited the feed may also answer 200 with an HTML "request denied" page.
  if (/^\s*<!DOCTYPE html|^\s*<html/i.test(text)) {
    if (/rate|limit|denied/i.test(text)) throw new RateLimitError(RETRY_AFTER_LIMIT);
    throw new Error('Format kalender tidak dikenal');
  }
  return text;
}

export async function fetchFeed(fetcher: typeof fetch = fetch): Promise<NewsItem[]> {
  let xmlError: Error;
  try {
    return parseForexFactoryXml(await fetchText(XML_URL, 'application/xml,text/xml', fetcher));
  } catch (e) {
    xmlError = e as Error;
  }
  try {
    return parseForexFactory(JSON.parse(await fetchText(JSON_URL, 'application/json', fetcher)));
  } catch (e) {
    // Both limited: back off for the shorter wait. Otherwise report what went wrong.
    if (xmlError instanceof RateLimitError && e instanceof RateLimitError) {
      throw new RateLimitError(Math.min(xmlError.retryAfterMs, e.retryAfterMs));
    }
    throw e instanceof RateLimitError ? xmlError : e;
  }
}

// Whether the kept copy should be refreshed now. `soon` (before the daily digest) asks
// for a copy at most an hour old, so the week rollover is picked up in time.
export function needsRefresh(cal: Calendar, now: number, soon = false): boolean {
  // After a rate limit the feed's own retry time decides; 30 minutes is for other errors.
  if (cal.retryAt) return now >= Date.parse(cal.retryAt);
  const attempted = cal.attemptedAt ? Date.parse(cal.attemptedAt) : 0;
  if (cal.error) return now - attempted >= RETRY_AFTER_ERROR;
  const fetched = cal.fetchedAt ? Date.parse(cal.fetchedAt) : 0;
  return now - fetched >= (soon ? HOUR : REFRESH_EVERY);
}

// Fetches and returns the new calendar. A failure keeps the old items and records the
// error (and the backoff after a rate limit).
export async function refreshCalendar(cal: Calendar, now: number, fetcher: typeof fetch = fetch): Promise<Calendar> {
  const attemptedAt = new Date(now).toISOString();
  try {
    const items = await fetchFeed(fetcher);
    return { items, fetchedAt: attemptedAt, attemptedAt, error: null, retryAt: null };
  } catch (e) {
    const retryAt = e instanceof RateLimitError ? new Date(now + e.retryAfterMs).toISOString() : null;
    return { ...cal, attemptedAt, error: (e as Error).message, retryAt };
  }
}
