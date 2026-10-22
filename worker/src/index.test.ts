import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { run, type Env } from './index.ts';

const H = 3_600_000;

function fakeKv() {
  const data = new Map<string, string>();
  let writes = 0;
  const kv = {
    async get(key: string) {
      const v = data.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async put(key: string, value: string) {
      writes++;
      data.set(key, value);
    },
  };
  return { kv, data, writes: () => writes };
}

describe('run', () => {
  const now = Date.parse('2026-10-23T05:00:00Z'); // Fri 12:00 WIB
  const feed = [
    { title: 'Non-Farm Employment Change', country: 'USD', date: '2026-10-23T08:30:00-04:00', impact: 'High' },
    { title: 'Retail Sales', country: 'CAD', date: '2026-10-23T08:30:00-04:00', impact: 'Medium' },
  ];

  it('fetches the feed once, sends one alert per stage, and writes KV only on change', async () => {
    const { kv, writes } = fakeKv();
    let feedCalls = 0;
    const telegram: Record<string, unknown>[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('.xml')) return new Response('', { status: 503 });
      if (url.includes('faireconomy')) {
        feedCalls++;
        return new Response(JSON.stringify(feed));
      }
      telegram.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const env = { NEWS: kv, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '-100', TOPIC_NEWS_ALERT: '7', PAIRS: 'EURUSD' } as unknown as Env;

    await run(env, now, fetcher);
    assert.equal(feedCalls, 1);
    assert.equal(telegram.length, 1);
    assert.equal(telegram[0]!.message_thread_id, 7);
    assert.match(String(telegram[0]!.text), /🔴 <b>High impact · 7 jam 30 menit lagi[\s\S]*USD · Non-Farm[\s\S]*Pair: EURUSD/);
    const w = writes();

    await run(env, now + 5 * 60_000, fetcher);
    assert.equal(feedCalls, 1); // kept copy is fresh
    assert.equal(telegram.length, 1);
    assert.equal(writes(), w); // nothing changed, nothing written

    await run(env, now + 7 * H, fetcher); // 30 minutes before
    assert.equal(telegram.length, 2);
    assert.match(String(telegram[1]!.text), /30 menit lagi/);
  });

  it('a failed send is retried on the next run', async () => {
    const { kv } = fakeKv();
    let fail = true;
    let sent = 0;
    const fetcher = (async (url: string) => {
      if (url.includes('faireconomy')) return new Response(JSON.stringify(feed));
      if (fail) return Response.json({ ok: false, description: 'Bad Request: chat not found' }, { status: 400 });
      sent++;
      return Response.json({ ok: true });
    }) as typeof fetch;
    const env = { NEWS: kv, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '-100' } as unknown as Env;
    const report = await run(env, now, fetcher);
    assert.ok(report.some((l) => l.includes('chat not found')));
    fail = false;
    await run(env, now + 5 * 60_000, fetcher);
    assert.equal(sent, 1);
  });

  it('backs off after a rate limit and warns the group once', async () => {
    const { kv } = fakeKv();
    let feedCalls = 0;
    const texts: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.includes('faireconomy')) {
        feedCalls++;
        return new Response('Too many', { status: 429, headers: { 'retry-after': '600' } });
      }
      texts.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true });
    }) as typeof fetch;
    const env = { NEWS: kv, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '-100' } as unknown as Env;
    await run(env, now, fetcher);
    await run(env, now + 5 * 60_000, fetcher);
    assert.equal(feedCalls, 2); // XML and JSON once each, then retry-after 10 minutes
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /belum pernah berhasil diambil \(rate limit/);
  });
});
