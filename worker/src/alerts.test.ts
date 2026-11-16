import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Calendar, NewsItem } from './calendar.ts';
import { EMPTY_LOG, eventKey, planAlerts, planDigest, planHealth, planOthers, pruneLog, type SentLog } from './alerts.ts';

const H = 3_600_000;
const M = 60_000;
// Friday 23 Oct 2026, 12:00 WIB
const NOW = Date.parse('2026-10-23T05:00:00Z');
const PAIRS = ['AUDUSD', 'EURUSD', 'USDJPY', 'EURGBP'];

const item = (at: number, currency = 'USD', title = 'Non-Farm Employment Change', impact: NewsItem['impact'] = 'high'): NewsItem => ({
  at: new Date(at).toISOString(),
  currency,
  impact,
  title,
});
const cal = (items: NewsItem[], over: Partial<Calendar> = {}): Calendar => ({
  items,
  fetchedAt: new Date(NOW - H).toISOString(),
  attemptedAt: new Date(NOW - H).toISOString(),
  error: null,
  retryAt: null,
  ...over,
});
const fresh = (): SentLog => structuredClone(EMPTY_LOG);

// Runs every 5 minutes from `from` to `to`, applying every message; returns the headlines.
function simulate(c: Calendar, from: number, to: number, log = fresh()): string[] {
  const sent: string[] = [];
  for (let t = from; t <= to; t += 5 * M) {
    for (const o of planAlerts(c, log, t, PAIRS)) {
      sent.push(o.text.split('\n')[0]!);
      o.mark(log);
    }
  }
  return sent;
}

describe('planAlerts', () => {
  it('sends 48h, 24h, 4h, 1h, 30m and the release once each, then nothing after the release', () => {
    const at = NOW + 50 * H;
    const sent = simulate(cal([item(at)]), NOW, at + H);
    assert.deepEqual(sent, [
      '🔴 <b>High impact · in 48 hours</b>',
      '🔴 <b>High impact · in 24 hours</b>',
      '⏰ <b>High impact · in 4 hours</b>',
      '⏰ <b>High impact · in 1 hour</b>',
      '⏰ <b>High impact · in 30 minutes</b>',
      '🚨 <b>High impact · releasing now</b>',
    ]);
  });

  it('a late run still sends the release alert up to 15 minutes after, with the real delay', () => {
    const at = NOW;
    const log = fresh();
    for (const s of ['48h', '24h', '4h', '1h', '30m'] as const) log.events[eventKey(item(at))] = [...(log.events[eventKey(item(at))] ?? []), s];
    const [o] = planAlerts(cal([item(at)]), log, at + 10 * M, PAIRS);
    assert.match(o!.text, /🚨 <b>High impact · released 10 minutes ago<\/b>/);
    assert.equal(planAlerts(cal([item(at)]), fresh(), at + 15 * M, PAIRS).length, 0);
  });

  it('filters on impact only: any currency, no medium or low', () => {
    const at = NOW + 2 * H;
    const out = planAlerts(cal([item(at, 'CNY', 'GDP q/y'), item(at, 'EUR', 'CPI', 'medium'), item(at, 'GBP', 'PMI', 'low')]), fresh(), NOW, PAIRS);
    assert.equal(out.length, 1);
    assert.match(out[0]!.text, /CNY · GDP q\/y/);
    assert.doesNotMatch(out[0]!.text, /Pairs:/); // no listed pair has CNY
  });

  it('groups events at the same time into one message and lists the affected pairs', () => {
    const at = NOW + 2 * H;
    const out = planAlerts(cal([item(at), item(at, 'USD', 'Unemployment Rate'), item(at + H, 'EUR', 'CPI')]), fresh(), NOW, PAIRS);
    assert.equal(out.length, 2);
    assert.match(out[0]!.text, /Non-Farm[\s\S]*Unemployment Rate\nPairs: AUDUSD, EURUSD, USDJPY$/);
    assert.match(out[0]!.text, /Fri, 23 Oct · 14:00 WIB/);
  });

  it('an event first seen late gets only its current stage, with the real time left', () => {
    const at = NOW + 2 * H + 10 * M;
    const log = fresh();
    const [o] = planAlerts(cal([item(at)]), log, NOW, PAIRS);
    assert.match(o!.text, /High impact · in 2 hours 10 minutes/);
    o!.mark(log);
    assert.deepEqual(log.events[eventKey(item(at))], ['48h', '24h', '4h']);
    assert.equal(planAlerts(cal([item(at)]), log, NOW + 5 * M, PAIRS).length, 0);
  });

  it('a rescheduled event starts over', () => {
    const log = fresh();
    for (const o of planAlerts(cal([item(NOW + 3 * H)]), log, NOW, PAIRS)) o.mark(log);
    assert.equal(planAlerts(cal([item(NOW + 5 * H)]), log, NOW, PAIRS).length, 1);
  });

  it('escapes HTML in titles', () => {
    const [o] = planAlerts(cal([item(NOW + H, 'USD', 'S&P <Global> PMI')]), fresh(), NOW, PAIRS);
    assert.match(o!.text, /S&amp;P &lt;Global&gt; PMI/);
  });
});

describe('planOthers', () => {
  it('sends medium and low news once, 30 minutes before, grouped by time; never high', () => {
    const at = NOW + 2 * H;
    const c = cal([item(at, 'EUR', 'CPI', 'medium'), item(at, 'GBP', 'PMI', 'low'), item(at, 'USD', 'NFP'), item(at + H, 'JPY', 'BoJ', 'low')]);
    const log = fresh();
    assert.equal(planOthers(c, log, at - 35 * M, PAIRS).length, 0);
    const out = planOthers(c, log, at - 30 * M, PAIRS);
    assert.equal(out.length, 1);
    assert.equal(
      out[0]!.text,
      ['🔔 <b>News · in 30 minutes</b>', 'Fri, 23 Oct · 14:00 WIB', '• 🟠 EUR · CPI', '• 🟡 GBP · PMI', 'Pairs: EURUSD, EURGBP'].join('\n'),
    );
    out[0]!.mark(log);
    assert.equal(planOthers(c, log, at - 25 * M, PAIRS).length, 0);
    assert.equal(planOthers(c, log, at, PAIRS).length, 0); // released
  });

  it('a late first sight shows the real time left', () => {
    const [o] = planOthers(cal([item(NOW + 12 * M, 'CAD', 'Retail Sales', 'medium')]), fresh(), NOW, PAIRS);
    assert.match(o!.text, /News · in 12 minutes/);
  });
});

describe('planDigest', () => {
  const fivePastFive = Date.parse('2026-10-22T22:05:00Z'); // Fri 23 Oct 05:05 WIB
  const items = [
    item(Date.parse('2026-10-22T21:00:00Z'), 'AUD', 'Before window'), // 04:00 WIB
    item(Date.parse('2026-10-23T12:30:00Z')), // 19:30 WIB
    item(Date.parse('2026-10-23T12:30:00Z'), 'EUR', 'CPI', 'medium'),
    item(Date.parse('2026-10-23T18:00:00Z'), 'NZD', 'GDP q/q'), // Sat 01:00 WIB
    item(Date.parse('2026-10-23T22:00:00Z'), 'JPY', 'Next day'), // Sat 05:00 WIB
    item(Date.parse('2026-10-24T22:00:00Z'), 'CHF', 'After window'), // Sun 05:00 WIB
  ];

  it('lists news of every impact from 05:00 WIB for 48 hours, once', () => {
    const log = fresh();
    const d = planDigest(cal(items), log, fivePastFive);
    assert.equal(
      d!.text,
      [
        '📅 <b>Daily Outlook · Fri, 23 Oct</b>',
        'All news from 05:00 WIB today to 05:00 WIB in two days',
        '',
        '19:30 · 🔴 USD · Non-Farm Employment Change',
        '19:30 · 🟠 EUR · CPI',
        '<i>Sat, 24 Oct</i>',
        '01:00 · 🔴 NZD · GDP q/q',
        '05:00 · 🔴 JPY · Next day',
      ].join('\n'),
    );
    d!.mark(log);
    assert.equal(planDigest(cal(items), log, fivePastFive + 5 * M), null);
  });

  it('runs from 05:00 until 08:00 WIB only', () => {
    assert.equal(planDigest(cal(items), fresh(), Date.parse('2026-10-22T21:55:00Z')), null); // 04:55
    assert.notEqual(planDigest(cal(items), fresh(), Date.parse('2026-10-23T00:55:00Z')), null); // 07:55
    assert.equal(planDigest(cal(items), fresh(), Date.parse('2026-10-23T01:00:00Z')), null); // 08:00
  });

  it('sends on weekends too', () => {
    const sat = planDigest(cal([]), fresh(), Date.parse('2026-10-23T22:05:00Z')); // Sat 05:05 WIB
    assert.match(sat!.text, /Sat, 24 Oct[\s\S]*No news\./);
    const sun = planDigest(cal([]), fresh(), Date.parse('2026-10-24T22:05:00Z'));
    assert.match(sun!.text, /Sun, 25 Oct[\s\S]*No news\./);
  });
});

describe('planHealth', () => {
  it('warns once when the calendar is stale, then notes the recovery', () => {
    const log = fresh();
    const stale = cal([], { fetchedAt: new Date(NOW - 13 * H).toISOString(), error: 'HTTP 503' });
    const w = planHealth(stale, log, NOW);
    assert.match(w!.text, /last fetched 13 hours ago \(HTTP 503\)/);
    w!.mark(log);
    assert.equal(planHealth(stale, log, NOW + H), null);
    const ok = planHealth(cal([]), log, NOW + 2 * H);
    assert.match(ok!.text, /back to normal/);
    ok!.mark(log);
    assert.equal(planHealth(cal([]), log, NOW + 3 * H), null);
  });

  it('warns at once when the feed never worked', () => {
    const w = planHealth(cal([], { fetchedAt: null, error: 'rate limit' }), fresh(), NOW);
    assert.match(w!.text, /never fetched \(rate limit\)/);
  });
});

describe('pruneLog', () => {
  it('drops events released more than two days ago', () => {
    const log = { ...fresh(), events: { [eventKey(item(NOW - 3 * 24 * H))]: ['24h' as const], [eventKey(item(NOW - H))]: ['30m' as const] } };
    assert.deepEqual(Object.keys(pruneLog(log, NOW).events), [eventKey(item(NOW - H))]);
  });
});
