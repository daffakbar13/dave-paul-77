// ForexFactory weekly feed, fetched at most every 4 hours and kept in KV. Every other
// reader (the alert runs, the Render server) uses the kept copy, so the feed sees about
// six requests a day from here and none from Render.
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
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

export async function fetchFeed(fetcher: typeof fetch = fetch): Promise<NewsItem[]> {
  const res = await fetcher(FEED_URL, {
    headers: { 'User-Agent': 'DavePaul77-Worker/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    const secs = Number(res.headers.get('retry-after'));
    throw new RateLimitError(secs > 0 ? secs * 1000 : RETRY_AFTER_LIMIT);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // When limited the feed may also answer 200 with an HTML "request denied" page.
  const text = await res.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    if (/rate|limit|denied/i.test(text)) throw new RateLimitError(RETRY_AFTER_LIMIT);
    throw new Error('Format kalender tidak dikenal');
  }
  return parseForexFactory(raw);
}

// Whether the kept copy should be refreshed now. `soon` (before the daily digest) asks
// for a copy at most an hour old, so the week rollover is picked up in time.
export function needsRefresh(cal: Calendar, now: number, soon = false): boolean {
  if (cal.retryAt && now < Date.parse(cal.retryAt)) return false;
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
