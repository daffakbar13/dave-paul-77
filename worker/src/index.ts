// DavePaul77 news worker: every 5 minutes it keeps the ForexFactory calendar fresh in KV,
// posts high-impact alerts, medium/low heads-ups (own topic) and the 05:00 WIB Daily Outlook to the Telegram group, and
// serves the kept calendar at GET /calendar for the Render server (NEWS_SOURCE=worker).
import { EMPTY_CALENDAR, needsRefresh, refreshCalendar, type Calendar } from './calendar.ts';
import { EMPTY_LOG, parsePairs, planAlerts, planDigest, planOthers, planHealth, pruneLog, type Outgoing, type SentLog } from './alerts.ts';
import { sendMessage } from './telegram.ts';

export type Env = {
  NEWS: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TOPIC_NEWS_ALERT?: string;
  TOPIC_DAILY_OUTLOOK?: string;
  TOPIC_OTHER_NEWS?: string; // medium/low impact; not sent until set
  PAIRS?: string;
};

const CALENDAR = 'calendar';
const SENT = 'sent';

export async function run(env: Env, now: number, fetcher: typeof fetch = fetch): Promise<string[]> {
  const report: string[] = [];
  let cal = (await env.NEWS.get<Calendar>(CALENDAR, 'json')) ?? EMPTY_CALENDAR;
  const before = await env.NEWS.get<SentLog>(SENT, 'json');
  const log: SentLog = pruneLog(before ?? EMPTY_LOG, now);

  const digestDue = planDigest(cal, log, now) !== null;
  if (needsRefresh(cal, now, digestDue)) {
    cal = await refreshCalendar(cal, now, fetcher);
    await env.NEWS.put(CALENDAR, JSON.stringify(cal));
    report.push(cal.error ? `calendar error: ${cal.error}` : `calendar: ${cal.items.length} items`);
  }

  const out: Outgoing[] = [];
  const health = planHealth(cal, log, now);
  if (health) out.push(health);
  out.push(...planAlerts(cal, log, now, parsePairs(env.PAIRS)));
  if (env.TOPIC_OTHER_NEWS) out.push(...planOthers(cal, log, now, parsePairs(env.PAIRS)));
  const digest = planDigest(cal, log, now);
  if (digest) out.push(digest);

  for (const o of out) {
    const threadId = { alert: env.TOPIC_NEWS_ALERT, other: env.TOPIC_OTHER_NEWS, digest: env.TOPIC_DAILY_OUTLOOK }[o.topic];
    try {
      await sendMessage({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, threadId }, o.text, fetcher);
      o.mark(log);
      report.push(`sent ${o.topic}: ${o.text.split('\n')[0]}`);
    } catch (e) {
      report.push(`send failed (${o.topic}): ${(e as Error).message}`); // retried next run
    }
  }

  // KV allows 1000 writes a day on the free plan: write only when something changed.
  if (JSON.stringify(log) !== JSON.stringify(before)) await env.NEWS.put(SENT, JSON.stringify(log));
  return report;
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(run(env, Date.now()).then((r) => r.forEach((line) => console.log(line))));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/calendar') {
      // Public data; the edge cache keeps repeated reads off the KV quota.
      const cal = (await env.NEWS.get<Calendar>(CALENDAR, { type: 'json', cacheTtl: 300 })) ?? EMPTY_CALENDAR;
      return Response.json({ source: 'forexfactory', ...cal }, { headers: { 'Cache-Control': 'public, max-age=300' } });
    }
    if (url.pathname === '/') return new Response('DavePaul77 news worker: GET /calendar');
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
