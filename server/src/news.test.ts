import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import type { AccountDoc } from './db.ts';
import { isAffected, isWeekend, newsWindowEnd, parseForexFactory, parseWorkerCalendar, type Aggressive } from './news.ts';
import { multiplierFor } from './service.ts';

describe('isWeekend', () => {
  it('covers Saturday and Sunday until the week opens at 21:00 UTC', () => {
    assert.equal(isWeekend(new Date('2026-10-23T20:59:00Z')), false); // Friday
    assert.equal(isWeekend(new Date('2026-10-24T12:00:00Z')), true); // Saturday
    assert.equal(isWeekend(new Date('2026-10-25T20:59:00Z')), true); // Sunday before open
    assert.equal(isWeekend(new Date('2026-10-25T21:00:00Z')), false); // Sunday open
  });
});

describe('newsWindowEnd', () => {
  const wib = (iso: string) => Date.parse(`${iso}+07:00`);
  it('counts from the 05:00 WIB nearest to now', () => {
    assert.equal(newsWindowEnd(wib('2026-10-27T07:00:00'), 48), wib('2026-10-29T05:00:00')); // Tue 07:00 -> Thu 05:00
    assert.equal(newsWindowEnd(wib('2026-10-27T23:00:00'), 48), wib('2026-10-30T05:00:00')); // Tue 23:00 -> Fri 05:00
    assert.equal(newsWindowEnd(wib('2026-10-28T02:00:00'), 48), wib('2026-10-30T05:00:00')); // Wed 02:00 -> Fri 05:00
    assert.equal(newsWindowEnd(wib('2026-10-27T05:00:00'), 48), wib('2026-10-29T05:00:00'));
  });
});

describe('parseWorkerCalendar', () => {
  const now = Date.parse('2026-10-23T05:00:00Z');
  const items = [
    { at: '2026-10-23T12:30:00.000Z', currency: 'USD', impact: 'high', title: 'Non-Farm Employment Change' },
    { at: 'bad', currency: 'EUR', impact: 'high', title: 'Broken' },
  ];

  it('reads the worker items as dates', () => {
    const out = parseWorkerCalendar({ items, fetchedAt: '2026-10-23T03:00:00.000Z', error: null }, now);
    assert.deepEqual(out, [{ at: new Date('2026-10-23T12:30:00Z'), currency: 'USD', impact: 'high', title: 'Non-Farm Employment Change' }]);
  });

  it('a copy older than 12 hours fails like a fetch, with the worker error', () => {
    assert.throws(
      () => parseWorkerCalendar({ items, fetchedAt: '2026-10-22T15:00:00.000Z', error: 'rate limit' }, now),
      /terakhir berhasil 14 jam lalu \(rate limit\)/,
    );
    assert.throws(() => parseWorkerCalendar({ items: [], fetchedAt: null, error: 'HTTP 503' }, now), /belum pernah berhasil/);
  });
});

describe('parseForexFactory', () => {
  const raw = [
    { title: 'CPI y/y', country: 'GBP', date: '2026-10-21T02:00:00-04:00', impact: 'High', forecast: '', previous: '' },
    { title: 'Bank Holiday', country: 'JPY', date: '2026-10-22T00:00:00-04:00', impact: 'Holiday' },
    { title: 'IMF Meetings', country: 'All', date: '2026-10-18T10:15:00-04:00', impact: 'Low' },
    { title: 'Retail Sales', country: 'usd', date: '2026-10-23T08:30:00-04:00', impact: 'Medium' },
    { title: 'Broken', country: 'EUR', date: 'not a date', impact: 'High' },
  ];

  it('keeps real currencies with a known impact and converts the New York time to UTC', () => {
    const items = parseForexFactory(raw);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { at: new Date('2026-10-21T06:00:00Z'), currency: 'GBP', impact: 'high', title: 'CPI y/y' });
    assert.equal(items[1]!.currency, 'USD');
    assert.equal(items[1]!.impact, 'medium');
  });

  it('rejects an unexpected payload', () => {
    assert.throws(() => parseForexFactory({ error: 'blocked' }), /Format kalender/);
  });
});

describe('Aggressive multiplier', () => {
  const account = { _id: new ObjectId(), aggressiveMultiplier: 2, aggressiveAuto: true } as AccountDoc;
  const usdNews: Aggressive = { mode: 'auto', affected: new Set(['USD']) };

  it('auto: only pairs with a currency that has red news', () => {
    assert.equal(multiplierFor(account, 'EURUSD', usdNews), 2);
    assert.equal(multiplierFor(account, 'USDJPY', usdNews), 2);
    assert.equal(multiplierFor(account, 'EURGBP', usdNews), 1);
  });

  it('auto: accounts with automatic Aggressive switched off stay at 1x', () => {
    assert.equal(multiplierFor({ ...account, aggressiveAuto: false }, 'EURUSD', usdNews), 1);
  });

  it('on: every pair; off: none', () => {
    assert.equal(multiplierFor(account, 'EURGBP', { mode: 'on', affected: new Set() }), 2);
    assert.equal(multiplierFor(account, 'EURUSD', { mode: 'off', affected: new Set(['USD']) }), 1);
  });

  it('matches broker-suffixed symbols', () => {
    assert.equal(isAffected('XAUUSD.m', new Set(['USD'])), true);
  });
});

describe('refreshNews', async () => {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const { collections } = await import('./db.ts');
  const { MongoClient } = await import('mongodb');
  const { RateLimitError, refreshNews } = await import('./news.ts');
  const mongo = await MongoMemoryServer.create();
  const client = await MongoClient.connect(mongo.getUri());
  const db = collections(client.db('news_test'));
  after(async () => {
    await client.close();
    await mongo.stop();
  });

  let calls = 0;
  let fail: Error | null = null;
  const provider = {
    name: 'fake',
    async fetch() {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      if (fail) throw fail;
      return [{ at: new Date(), currency: 'USD', impact: 'high' as const, title: 'NFP' }];
    },
  };

  it('shares one fetch between concurrent requests on a stale cache', async () => {
    await Promise.all([refreshNews(db, provider), refreshNews(db, provider), refreshNews(db, provider)]);
    assert.equal(calls, 1);
    await refreshNews(db, provider);
    assert.equal(calls, 1); // fresh cache
  });

  it('backs off after a rate limit, also for the manual button', async () => {
    await db.meta.deleteMany({});
    calls = 0;
    fail = new RateLimitError(30 * 60_000);
    const s = await refreshNews(db, provider);
    assert.match(s.error ?? '', /rate limit/);
    assert.ok(s.retryAt && s.retryAt.getTime() > Date.now() + 29 * 60_000);
    fail = null;
    await db.meta.updateOne({ _id: 'news' }, { $set: { fetchedAt: new Date(Date.now() - 20 * 60_000) } });
    await refreshNews(db, provider);
    await refreshNews(db, provider, true);
    assert.equal(calls, 1);
    await db.meta.updateOne({ _id: 'news' }, { $set: { retryAt: new Date(Date.now() - 1) } });
    const ok = await refreshNews(db, provider);
    assert.equal(calls, 2);
    assert.equal(ok.error, null);
    assert.equal(ok.retryAt, null);
  });
});
