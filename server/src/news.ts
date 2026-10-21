// Economic calendar: one swappable provider, cached in the `news` collection. Only
// high-impact ("red") items matter; they drive the banner and automatic Aggressive.
import { currenciesOf } from './analysis/orders.ts';
import type { Collections, NewsDoc, Settings } from './db.ts';

const HOUR = 3_600_000;
const REFRESH_EVERY = HOUR; // the ForexFactory feed itself updates about hourly
const RETRY_AFTER_ERROR = 10 * 60_000;

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
    if (!res.ok) throw new Error(`Kalender HTTP ${res.status}`);
    return parseForexFactory(await res.json());
  },
};

export function providerFromEnv(name = process.env.NEWS_SOURCE ?? 'forexfactory'): NewsProvider | null {
  if (name === 'none') return null;
  if (name === 'forexfactory') return forexFactory;
  throw new Error(`NEWS_SOURCE tidak dikenal: ${name} (forexfactory atau none)`);
}

export type NewsStatus = { source: string | null; fetchedAt: Date | null; error: string | null };

export async function newsStatus(db: Collections): Promise<NewsStatus> {
  const m = await db.meta.findOne({ _id: 'news' });
  return { source: m?.source ?? null, fetchedAt: m?.fetchedAt ?? null, error: m?.error ?? null };
}

// Fetches when the cache is older than an hour (10 minutes after a failure). Called
// lazily from requests, so a sleeping Render instance refreshes when it wakes up.
// A failed fetch keeps the old items and records the error for the banner.
export async function refreshNews(db: Collections, provider: NewsProvider | null, force = false): Promise<NewsStatus> {
  if (!provider) return { source: null, fetchedAt: null, error: null };
  const status = await newsStatus(db);
  const last = status.fetchedAt?.getTime() ?? 0;
  const age = Date.now() - last;
  const wait = status.error ? RETRY_AFTER_ERROR : REFRESH_EVERY;
  if (!force && age < wait) return status;
  if (force && age < 60_000) return status; // manual button, at most once a minute
  try {
    const items = await provider.fetch();
    if (items.length) {
      await db.news.bulkWrite(
        items.map((n) => ({ updateOne: { filter: { at: n.at, currency: n.currency, title: n.title }, update: { $set: n }, upsert: true } })),
        { ordered: false },
      );
    }
    await db.news.deleteMany({ at: { $lt: new Date(Date.now() - 14 * 24 * HOUR) } });
    const next = { source: provider.name, fetchedAt: new Date(), error: null };
    await db.meta.updateOne({ _id: 'news' }, { $set: next }, { upsert: true });
    return next;
  } catch (e) {
    const next = { source: provider.name, fetchedAt: new Date(), error: (e as Error).message };
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
