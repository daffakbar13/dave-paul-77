import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_CALENDAR, RateLimitError, fetchFeed, needsRefresh, parseForexFactory, parseForexFactoryXml, type Calendar } from './calendar.ts';

const H = 3_600_000;

describe('parseForexFactory', () => {
  it('keeps every currency with a known impact, in UTC, sorted', () => {
    const items = parseForexFactory([
      { title: 'GDP', country: 'CNY', date: '2026-10-21T22:00:00-04:00', impact: 'High' },
      { title: 'CPI y/y', country: 'GBP', date: '2026-10-21T02:00:00-04:00', impact: 'High' },
      { title: 'Bank Holiday', country: 'JPY', date: '2026-10-22T00:00:00-04:00', impact: 'Holiday' },
      { title: 'Broken', country: 'EUR', date: 'not a date', impact: 'High' },
    ]);
    assert.deepEqual(items, [
      { at: '2026-10-21T06:00:00.000Z', currency: 'GBP', impact: 'high', title: 'CPI y/y' },
      { at: '2026-10-22T02:00:00.000Z', currency: 'CNY', impact: 'high', title: 'GDP' },
    ]);
  });
});

describe('needsRefresh', () => {
  const now = Date.parse('2026-10-23T05:00:00Z');
  const at = (ms: number) => new Date(ms).toISOString();
  const ok = (age: number): Calendar => ({ ...EMPTY_CALENDAR, fetchedAt: at(now - age), attemptedAt: at(now - age) });

  it('every 4 hours, every hour before the digest', () => {
    assert.equal(needsRefresh(EMPTY_CALENDAR, now), true);
    assert.equal(needsRefresh(ok(3 * H), now), false);
    assert.equal(needsRefresh(ok(4 * H), now), true);
    assert.equal(needsRefresh(ok(H), now, true), true);
  });

  it('30 minutes after an error; after a rate limit exactly at its retry time', () => {
    const err = { ...ok(5 * H), attemptedAt: at(now - 20 * 60_000), error: 'HTTP 503' };
    assert.equal(needsRefresh(err, now), false);
    assert.equal(needsRefresh({ ...err, attemptedAt: at(now - 30 * 60_000) }, now), true);
    assert.equal(needsRefresh({ ...err, attemptedAt: at(now - H), retryAt: at(now + 60_000) }, now), false);
    assert.equal(needsRefresh({ ...err, attemptedAt: at(now - 5 * 60_000), retryAt: at(now - 60_000) }, now), true);
  });
});

const XML = `<?xml version="1.0" encoding="windows-1252"?>
<weeklyevents>
	<event>
		<title>CPI m/m</title>
		<country>CAD</country>
		<date><![CDATA[10-19-2026]]></date>
		<time><![CDATA[12:30pm]]></time>
		<impact><![CDATA[High]]></impact>
		<forecast />
	</event>
	<event>
		<title>S&amp;P Global PMI</title>
		<country>USD</country>
		<date><![CDATA[10-21-2026]]></date>
		<time><![CDATA[12:05am]]></time>
		<impact><![CDATA[Medium]]></impact>
	</event>
	<event>
		<title>Bank Holiday</title>
		<country>JPY</country>
		<date><![CDATA[10-20-2026]]></date>
		<time><![CDATA[All Day]]></time>
		<impact><![CDATA[Holiday]]></impact>
	</event>
	<event>
		<title>BOJ Policy Rate</title>
		<country>JPY</country>
		<date><![CDATA[10-22-2026]]></date>
		<time><![CDATA[Tentative]]></time>
		<impact><![CDATA[High]]></impact>
	</event>
</weeklyevents>`;

describe('parseForexFactoryXml', () => {
  it('reads UTC clock times, decodes entities, drops rows without a time', () => {
    assert.deepEqual(parseForexFactoryXml(XML), [
      { at: '2026-10-19T12:30:00.000Z', currency: 'CAD', impact: 'high', title: 'CPI m/m' },
      { at: '2026-10-21T00:05:00.000Z', currency: 'USD', impact: 'medium', title: 'S&P Global PMI' },
    ]);
  });

  it('rejects an unexpected payload', () => {
    assert.throws(() => parseForexFactoryXml('<html>denied</html>'), /tidak dikenal/);
  });
});

describe('fetchFeed', () => {
  const limited = (secs: number) => new Response('<!DOCTYPE html><html>slow down</html>', { status: 429, headers: { 'retry-after': String(secs) } });
  const json = JSON.stringify([{ title: 'GDP', country: 'CNY', date: '2026-10-21T22:00:00-04:00', impact: 'High' }]);

  it('uses the XML feed first', async () => {
    const urls: string[] = [];
    const items = await fetchFeed((async (u: string) => (urls.push(u), new Response(XML))) as typeof fetch);
    assert.equal(items.length, 2);
    assert.deepEqual(urls.map((u) => u.slice(-4)), ['.xml']);
  });

  it('falls back to JSON when the XML feed is limited', async () => {
    const items = await fetchFeed((async (u: string) => (u.endsWith('.xml') ? limited(300) : new Response(json))) as typeof fetch);
    assert.equal(items[0]?.currency, 'CNY');
  });

  it('both limited: backs off for the shorter wait', async () => {
    await assert.rejects(
      fetchFeed((async (u: string) => limited(u.endsWith('.xml') ? 300 : 120)) as typeof fetch),
      (e) => e instanceof RateLimitError && e.retryAfterMs === 120_000,
    );
  });
});
