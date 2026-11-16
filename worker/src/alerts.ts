// What to send on a run, as pure functions of the calendar, the sent log and the time.
// The caller sends each message and applies its `mark` only after Telegram accepted it,
// so a failed send is retried on the next run and a sent one never repeats.
import { HOUR, MINUTE, type Calendar, type NewsItem } from './calendar.ts';

const WIB = 7 * HOUR; // Asia/Jakarta, no daylight saving
const DIGEST_HOUR = 5; // 05:00 WIB
const DIGEST_HOURS = 32; // 05:00 WIB to 13:00 WIB the next day
const DIGEST_LATEST_HOUR = 8; // still sent until 08:00 WIB if the 05:00 run failed
const STALE_AFTER = 12 * HOUR;
const KEEP_SENT = 2 * 24 * HOUR;

export const STAGES = [
  { id: '32h', ms: 32 * HOUR, label: 'in 32 hours' },
  { id: '24h', ms: 24 * HOUR, label: 'in 24 hours' },
  { id: '4h', ms: 4 * HOUR, label: 'in 4 hours' },
  { id: '1h', ms: HOUR, label: 'in 1 hour' },
  { id: '30m', ms: 30 * MINUTE, label: 'in 30 minutes' },
  { id: 'now', ms: 0, label: 'releasing now' },
] as const;
// The release alert is still sent this long after the release time (a late or failed run).
const RELEASE_GRACE = 15 * MINUTE;
export type StageId = (typeof STAGES)[number]['id'];
type Stage = (typeof STAGES)[number];

export type SentLog = {
  events: Record<string, StageId[]>; // event key -> stages already sent
  digests: string[]; // WIB dates (YYYY-MM-DD) whose Daily Outlook was sent
  staleWarned: string | null; // fetchedAt (or 'never') the stale warning was sent for
};

export const EMPTY_LOG: SentLog = { events: {}, digests: [], staleWarned: null };

export type Topic = 'alert' | 'other' | 'digest';
export type Outgoing = { topic: Topic; text: string; mark: (log: SentLog) => void };

// Currency + title + time: a rescheduled event is a new event and starts over.
export const eventKey = (n: NewsItem) => `${n.currency}|${n.title}|${n.at}`;

// --- formatting -------------------------------------------------------------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

// The WIB wall clock as UTC fields of a shifted Date.
const wib = (ms: number) => new Date(ms + WIB);
export const fmtTime = (ms: number) => `${pad(wib(ms).getUTCHours())}:${pad(wib(ms).getUTCMinutes())}`;
export function fmtDay(ms: number): string {
  const d = wib(ms);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
export const wibDate = (ms: number) => wib(ms).toISOString().slice(0, 10);

export function fmtRemaining(ms: number): string {
  const mins = Math.max(1, Math.round(ms / MINUTE));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (mins < 60) return unit(mins, 'minute');
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${unit(h, 'hour')} ${unit(m, 'minute')}` : unit(h, 'hour');
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function parsePairs(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter((p) => /^[A-Z]{6}$/.test(p));
}

export function pairsFor(currencies: string[], pairs: string[]): string[] {
  return pairs.filter((p) => currencies.includes(p.slice(0, 3)) || currencies.includes(p.slice(3, 6)));
}

// --- News Alert -------------------------------------------------------------
// The stage an event is in now: the closest threshold it has passed.
function currentStage(remaining: number): Stage | null {
  if (remaining <= -RELEASE_GRACE) return null;
  let found: Stage | null = null;
  for (const s of STAGES) if (remaining <= s.ms) found = s;
  return found;
}

function alertText(at: number, items: NewsItem[], stage: Stage, now: number, pairs: string[]): string {
  const remaining = at - now;
  // On time it reads "in 1 hour"; an event first seen late (or a late run) shows the real gap.
  let label: string;
  if (stage.id === 'now') label = remaining > -2 * MINUTE ? stage.label : `released ${fmtRemaining(-remaining)} ago`;
  else label = stage.id !== STAGES[0].id && remaining > stage.ms - 10 * MINUTE ? stage.label : `in ${fmtRemaining(remaining)}`;
  const head = stage.id === 'now' ? '🚨' : stage.ms >= 24 * HOUR ? '🔴' : '⏰';
  const lines = [`${head} <b>High impact · ${label}</b>`, `${fmtDay(at)} · ${fmtTime(at)} WIB`];
  for (const n of items) lines.push(`• ${n.currency} · ${escape(n.title)}`);
  const affected = pairsFor([...new Set(items.map((n) => n.currency))], pairs);
  if (affected.length) lines.push(`Pairs: ${affected.join(', ')}`);
  return lines.join('\n');
}

// One message per release time and stage; high impact only, any currency.
export function planAlerts(cal: Calendar, log: SentLog, now: number, pairs: string[]): Outgoing[] {
  const groups = new Map<string, { at: number; stage: Stage; items: NewsItem[] }>();
  for (const n of cal.items) {
    if (n.impact !== 'high') continue;
    const at = Date.parse(n.at);
    const stage = currentStage(at - now);
    if (!stage || log.events[eventKey(n)]?.includes(stage.id)) continue;
    const g = groups.get(`${at}|${stage.id}`) ?? { at, stage, items: [] };
    g.items.push(n);
    groups.set(`${at}|${stage.id}`, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.at - b.at)
    .map(({ at, stage, items }) => ({
      topic: 'alert' as const,
      text: alertText(at, items, stage, now, pairs),
      mark: (l: SentLog) => {
        // The stage sent and every earlier one: a late run never sends "in 4 hours" after "in 1 hour".
        const done = STAGES.filter((s) => s.ms >= stage.ms).map((s) => s.id);
        for (const n of items) l.events[eventKey(n)] = [...new Set([...(l.events[eventKey(n)] ?? []), ...done])];
      },
    }));
}

// --- Other News -------------------------------------------------------------
// Medium and low impact (red stays in News Alert): one heads-up 30 minutes before each
// release time and one at the release (up to RELEASE_GRACE late), kept in `events` like a
// high-impact event's 30m and now stages.
const OTHER_BEFORE = 30 * MINUTE;
const IMPACT_ICON = { high: '🔴', medium: '🟠', low: '🟡' } as const;

export function planOthers(cal: Calendar, log: SentLog, now: number, pairs: string[]): Outgoing[] {
  const groups = new Map<string, { at: number; stage: '30m' | 'now'; items: NewsItem[] }>();
  for (const n of cal.items) {
    if (n.impact === 'high') continue;
    const at = Date.parse(n.at);
    const remaining = at - now;
    if (remaining <= -RELEASE_GRACE || remaining > OTHER_BEFORE) continue;
    const stage = remaining <= 0 ? 'now' : '30m';
    if (log.events[eventKey(n)]?.includes(stage)) continue;
    const g = groups.get(`${at}|${stage}`) ?? { at, stage, items: [] };
    g.items.push(n);
    groups.set(`${at}|${stage}`, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.at - b.at)
    .map(({ at, stage, items }) => {
      const remaining = at - now;
      let label: string;
      if (stage === 'now') label = remaining > -2 * MINUTE ? 'releasing now' : `released ${fmtRemaining(-remaining)} ago`;
      else label = remaining > OTHER_BEFORE - 10 * MINUTE ? 'in 30 minutes' : `in ${fmtRemaining(remaining)}`;
      const lines = [`🔔 <b>News · ${label}</b>`, `${fmtDay(at)} · ${fmtTime(at)} WIB`];
      for (const n of items) lines.push(`• ${IMPACT_ICON[n.impact]} ${n.currency} · ${escape(n.title)}`);
      const affected = pairsFor([...new Set(items.map((n) => n.currency))], pairs);
      if (affected.length) lines.push(`Pairs: ${affected.join(', ')}`);
      const done: StageId[] = stage === 'now' ? ['30m', 'now'] : ['30m'];
      return {
        topic: 'other' as const,
        text: lines.join('\n'),
        mark: (l: SentLog) => {
          for (const n of items) l.events[eventKey(n)] = [...new Set([...(l.events[eventKey(n)] ?? []), ...done])];
        },
      };
    });
}

// --- Daily Outlook ----------------------------------------------------------
// 05:00 WIB every day, weekends included, listing every impact for the 32 hours from
// 05:00 to 13:00 WIB the next day, like the web banner (an order placed in the morning must
// see tomorrow's morning news too). Runs until 08:00 retry a failed send.
export function planDigest(cal: Calendar, log: SentLog, now: number): Outgoing | null {
  const d = wib(now);
  const date = wibDate(now);
  if (d.getUTCHours() < DIGEST_HOUR || d.getUTCHours() >= DIGEST_LATEST_HOUR) return null;
  if (log.digests.includes(date)) return null;
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DIGEST_HOUR) - WIB;
  const end = start + DIGEST_HOURS * HOUR;
  const items = cal.items.filter((n) => Date.parse(n.at) >= start && Date.parse(n.at) < end);

  const lines = [`📅 <b>Daily Outlook · ${fmtDay(now)}</b>`, `All news from 05:00 WIB today to 13:00 WIB tomorrow`, ''];
  if (!items.length) lines.push('No news.');
  let day = '';
  for (const n of items) {
    const at = Date.parse(n.at);
    if (fmtDay(at) !== day && wibDate(at) !== date) lines.push(`<i>${fmtDay(at)}</i>`);
    day = fmtDay(at);
    lines.push(`${fmtTime(at)} · ${IMPACT_ICON[n.impact]} ${n.currency} · ${escape(n.title)}`);
  }
  if (isStale(cal, now)) lines.push('', `⚠️ ${staleNote(cal, now)}`);
  return {
    topic: 'digest',
    text: lines.join('\n'),
    mark: (l) => {
      l.digests = [...l.digests, date].slice(-10);
    },
  };
}

// --- feed health ------------------------------------------------------------
const isStale = (cal: Calendar, now: number) =>
  cal.fetchedAt ? now - Date.parse(cal.fetchedAt) > STALE_AFTER : cal.error !== null;

function staleNote(cal: Calendar, now: number): string {
  const age = cal.fetchedAt ? `last fetched ${fmtRemaining(now - Date.parse(cal.fetchedAt))} ago` : 'never fetched';
  return `ForexFactory calendar ${age} (${escape(cal.error ?? 'not updated')}); alerts may be missed.`;
}

// One warning when the kept calendar goes stale, one note when it recovers.
export function planHealth(cal: Calendar, log: SentLog, now: number): Outgoing | null {
  const id = cal.fetchedAt ?? 'never';
  if (isStale(cal, now)) {
    if (log.staleWarned === id) return null;
    return { topic: 'alert', text: `⚠️ ${staleNote(cal, now)}`, mark: (l) => void (l.staleWarned = id) };
  }
  if (log.staleWarned && cal.fetchedAt) {
    return { topic: 'alert', text: '✅ ForexFactory calendar is back to normal.', mark: (l) => void (l.staleWarned = null) };
  }
  return null;
}

// Drops events released more than two days ago.
export function pruneLog(log: SentLog, now: number): SentLog {
  const events: SentLog['events'] = {};
  for (const [k, stages] of Object.entries(log.events)) {
    const at = Date.parse(k.slice(k.lastIndexOf('|') + 1));
    if (now - at < KEEP_SENT) events[k] = stages;
  }
  return { ...log, events };
}
