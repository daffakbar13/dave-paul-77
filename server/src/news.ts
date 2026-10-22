// Economic calendar: one swappable provider, cached in the `news` collection. Only
// high-impact ("red") items matter; they drive the banner and automatic Aggressive.
import { currenciesOf } from './analysis/orders.ts';
import type { Collections, NewsDoc, Settings } from './db.ts';

const HOUR = 3_600_000;
const REFRESH_EVERY = HOUR; // the ForexFactory feed itself updates about hourly
const RETRY_AFTER_ERROR = 10 * 60_000;
const RETRY_AFTER_LIMIT = HOUR; // when the feed rate-limits without saying for how long
const FORCE_MIN_GAP = 5 * 60_000; // the feed allows only a couple of requests per few minutes

// The feed answered "too many requests"; retryAfterMs is how long to stay away.
export class RateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Kalender membatasi request (rate limit), coba lagi ${Math.ceil(retryAfterMs / 60_000)} menit lagi`);
    this.retryAfterMs = retryAfterMs;
  }
}

export type NewsItem = Omit<NewsDoc, '_id'>;

export type NewsProvider = { name: string; fetch: () => Promise<NewsItem[]> };

const IMPACT: Record<string, NewsItem['impact']> = { High: 'high', Medium: 'medium', Low: 'low' };

// ForexFactory weekly JSON (nfs.faireconomy.media): free, no key, current week only,
// times are ISO with the New York offset. Holidays and "All" items are dropped.
export function parseForexFactory(raw: unknown): NewsItem[] {
  if (!Array.isArray(raw)) throw new Error('Format kalender tidak dikenal');
  const out: NewsItem[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const impact = IMPACT[String(r.impact)];
    const currency = String(r.country ?? '').toUpperCase();
    const at = new Date(String(r.date));
    if (!impact || currency === 'ALL' || !/^[A-Z]{3}$/.test(currency) || Number.isNaN(at.getTime())) continue;
    out.push({ at, currency, impact, title: String(r.title ?? '').slice(0, 200) });
  }
  return out;
}

export const forexFactory: NewsProvider = {
  name: 'forexfactory',
  async fetch() {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      headers: { 'User-Agent': 'DavePaul77/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      const secs = Number(res.headers.get('retry-after'));
      throw new RateLimitError(secs > 0 ? secs * 1000 : RETRY_AFTER_LIMIT);
    }
    if (!res.ok) throw new Error(`Kalender HTTP ${res.status}`);
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
  },
};

export function providerFromEnv(name = process.env.NEWS_SOURCE ?? 'forexfactory'): NewsProvider | null {
  if (name === 'none') return null;
  if (name === 'forexfactory') return forexFactory;
  throw new Error(`NEWS_SOURCE tidak dikenal: ${name} (forexfactory atau none)`);
}

export type NewsStatus = { source: string | null; fetchedAt: Date | null; error: string | null; retryAt: Date | null };

export async function newsStatus(db: Collections): Promise<NewsStatus> {
  const m = await db.meta.findOne({ _id: 'news' });
  return { source: m?.source ?? null, fetchedAt: m?.fetchedAt ?? null, error: m?.error ?? null, retryAt: m?.retryAt ?? null };
}

// One fetch at a time: concurrent requests on a stale cache share it instead of each
// hitting the feed (that burst is what got us rate-limited).
let inflight: Promise<NewsStatus> | null = null;

// Fetches when the cache is older than an hour (10 minutes after a failure, or after
// the feed's own retry time when rate-limited). Called lazily from requests, so a
// sleeping Render instance refreshes when it wakes up. The manual button skips the
// hour but never the rate-limit backoff. A failed fetch keeps the old items and
// records the error for the banner.
export async function refreshNews(db: Collections, provider: NewsProvider | null, force = false): Promise<NewsStatus> {
  if (!provider) return { source: null, fetchedAt: null, error: null, retryAt: null };
  if (inflight) return inflight;
  const status = await newsStatus(db);
  if (inflight) return inflight;
  const now = Date.now();
  const last = status.fetchedAt?.getTime() ?? 0;
  if (status.retryAt && now < status.retryAt.getTime()) return status;
  const wait = force ? FORCE_MIN_GAP : status.error ? RETRY_AFTER_ERROR : REFRESH_EVERY;
  if (now - last < wait) return status;
  inflight = fetchAndStore(db, provider).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function fetchAndStore(db: Collections, provider: NewsProvider): Promise<NewsStatus> {
  try {
    const items = await provider.fetch();
    if (items.length) {
      await db.news.bulkWrite(
        items.map((n) => ({ updateOne: { filter: { at: n.at, currency: n.currency, title: n.title }, update: { $set: n }, upsert: true } })),
        { ordered: false },
      );
    }
    await db.news.deleteMany({ at: { $lt: new Date(Date.now() - 14 * 24 * HOUR) } });
    const next = { source: provider.name, fetchedAt: new Date(), error: null, retryAt: null };
    await db.meta.updateOne({ _id: 'news' }, { $set: next }, { upsert: true });
    return next;
  } catch (e) {
    const retryAt = e instanceof RateLimitError ? new Date(Date.now() + e.retryAfterMs) : null;
    const next = { source: provider.name, fetchedAt: new Date(), error: (e as Error).message, retryAt };
    await db.meta.updateOne({ _id: 'news' }, { $set: next }, { upsert: true });
    return next;
  }
}

// Red news from one hour ago (still shown after release) to the end of the window.
export async function upcomingRed(db: Collections, settings: Settings): Promise<NewsDoc[]> {
  const now = Date.now();
  return db.news
    .find({ impact: 'high', at: { $gte: new Date(now - HOUR), $lte: new Date(now + settings.newsWindowHours * HOUR) } })
    .sort({ at: 1 })
    .toArray();
}

// --- Aggressive -------------------------------------------------------------
// auto: on for pairs whose currency has red news ahead in the window, for accounts with
//       aggressiveAuto; on: every pair, every account; off: switched off for the session.
export type AggressiveMode = 'auto' | 'on' | 'off';
export type Aggressive = { mode: AggressiveMode; affected: Set<string> };

export const NO_AGGRESSIVE: Aggressive = { mode: 'off', affected: new Set() };

export async function aggressiveContext(db: Collections, settings: Settings, mode: AggressiveMode): Promise<Aggressive> {
  if (mode !== 'auto') return { mode, affected: new Set() };
  const now = Date.now();
  const ahead = (await upcomingRed(db, settings)).filter((n) => n.at.getTime() >= now);
  return { mode, affected: new Set(ahead.map((n) => n.currency)) };
}

export function isAffected(symbol: string, affected: Set<string>): boolean {
  return currenciesOf(symbol).some((c) => affected.has(c));
}
