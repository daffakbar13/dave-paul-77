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
  port: 0, mongoUri: '', dbName: 'settings_test', jwtSecret: 'test-secret', adminPasswordHash: 'x', eaDataKey: 'k', corsOrigins: [], newsSource: 'none', newsWorkerUrl: undefined,
};
const auth = { Authorization: `Bearer ${jwt.sign({ sub: 'admin' }, config.jwtSecret)}`, 'Content-Type': 'application/json' };
const call = (method: string, body?: unknown) =>
  fetch(`${base}/api/settings`, { method, headers: auth, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = collections(client.db('settings_test'));
  await ensureIndexes(db);
  server = createApp(db, config).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.close();
  await client.close();
  await mongo.stop();
});

describe('settings: backtest costs', () => {
  it('defaults to on, no slippage, default spreads', async () => {
    const s = await (await call('GET')).json();
    assert.deepEqual(s.costs, { enabled: true, slippagePips: 0, spreadPips: {} });
  });

  it('saves costs without a new settings version', async () => {
    const before = await (await call('GET')).json();
    const res = await call('PUT', { costs: { slippagePips: 0.3, spreadPips: { eurgbp: 1.5 } } });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.deepEqual(s.costs, { enabled: true, slippagePips: 0.3, spreadPips: { EURGBP: 1.5 } });
    assert.equal(s.version, before.version);
  });

  it('rejects a negative spread', async () => {
    assert.equal((await call('PUT', { costs: { spreadPips: { EURUSD: -1 } } })).status, 400);
  });
});
