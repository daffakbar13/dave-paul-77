import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../app.ts';
import type { Config } from '../config.ts';
import { collections, ensureIndexes, type Collections } from '../db.ts';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Collections;
let server: Server;
let base: string;

const config: Config = {
  port: 0, mongoUri: '', dbName: 'backtests_test', jwtSecret: 'test-secret', adminPasswordHash: 'x', eaDataKey: 'k', corsOrigins: [], newsSource: 'none', newsWorkerUrl: undefined,
};
const auth = { Authorization: `Bearer ${jwt.sign({ sub: 'admin' }, config.jwtSecret)}`, 'Content-Type': 'application/json' };
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/api/backtests${path}`, { method, headers: auth, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = collections(client.db('backtests_test'));
  await ensureIndexes(db);
  server = createApp(db, config).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.close();
  await client.close();
  await mongo.stop();
});

// ~30k trades, the size of 22 years of 14 pairs: more than the 100 kB the other routes accept
const trades = Array.from({ length: 30_000 }, (_, i) => [0, 'b', 1_700_000_000_000 + i * 86_400_000, null, 1.1, 1.102, 1.099, 'O', 20, 10, 0, 0, false, 5]);
const body = {
  name: 'Semua pair 2010-2014', balance: 6000, riskPct: 1, from: '2010-01-01', to: '2014-12-31', excluded: ['USDJPY'], sr: { lookback: 260 }, warmup: 260,
  coverage: [{ symbol: 'EURUSD', years: 5 }], fingerprint: [{ symbol: 'EURUSD', candles: 1300, first: 1, last: 2 }], trades,
};

describe('saved backtests', () => {
  it('create, list without trades, get with trades, rename, delete', async () => {
    const created = await call('POST', '', body);
    assert.equal(created.status, 201);
    const { backtest } = (await created.json()) as { backtest: { id: string; tradeCount: number; size: number } };
    assert.equal(backtest.tradeCount, 30_000);
    assert.ok(backtest.size < 1_000_000, `stored gzipped, ${backtest.size} bytes`);

    const list = (await (await call('GET', '')).json()) as { backtests: Record<string, unknown>[] };
    assert.equal(list.backtests.length, 1);
    assert.equal(list.backtests[0]!.name, body.name);
    assert.equal('trades' in list.backtests[0]!, false);

    const full = (await (await call('GET', `/${backtest.id}`)).json()) as typeof body & { id: string };
    assert.equal(full.id, backtest.id);
    assert.deepEqual(full.trades[29_999], trades[29_999]);
    assert.deepEqual(full.excluded, ['USDJPY']);
    assert.deepEqual(full.sr, { lookback: 260 });

    const renamed = await call('PUT', `/${backtest.id}`, { name: '  Baru ' });
    assert.equal(((await renamed.json()) as { backtest: { name: string } }).backtest.name, 'Baru');

    assert.equal((await call('DELETE', `/${backtest.id}`)).status, 204);
    assert.equal((await call('GET', `/${backtest.id}`)).status, 404);
  });

  it('rejects bad input and needs the admin token', async () => {
    const bad = await call('POST', '', { ...body, name: ' ' });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /Nama/);
    assert.equal((await call('PUT', '/nope', { name: 'x' })).status, 404);
    assert.equal((await fetch(`${base}/api/backtests`)).status, 401);
  });
});
