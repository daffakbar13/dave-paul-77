// Timeframe per pair end to end: the MT4 EA endpoints store D1 and H4 candles apart, and
// the analysis, the pair list and the backtest candles follow each pair's timeframe.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../app.ts';
import type { Config } from '../config.ts';
import { collections, ensureIndexes, type Collections } from '../db.ts';
import { sampleCandles } from '../sample.ts';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Collections;
let server: Server;
let base: string;

const config: Config = {
  port: 0, mongoUri: '', dbName: 'tf_test', jwtSecret: 'test-secret', adminPasswordHash: 'x', eaDataKey: 'data-key', corsOrigins: [], newsSource: 'none', newsWorkerUrl: undefined,
};
const web = { Authorization: `Bearer ${jwt.sign({ sub: 'admin' }, config.jwtSecret)}`, 'Content-Type': 'application/json' };
const ea = { 'X-Api-Key': config.eaDataKey, 'Content-Type': 'application/json' };
const call = async (path: string, headers: Record<string, string>, method = 'GET', body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};

const H4 = 14_400_000;
const NOW = Date.UTC(2026, 10, 17, 10, 30); // Tue 10:30 (broker clock): the 08:00 H4 bar is open
const asEa = (cs: { t: Date; o: number; h: number; l: number; c: number }[]) =>
  cs.map((c) => ({ t: c.t.getTime() / 1000, o: c.o, h: c.h, l: c.l, c: c.c }));

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = collections(client.db('tf_test'));
  await ensureIndexes(db);
  server = createApp(db, config).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await db.symbols.insertMany([
    { _id: new ObjectId(), name: 'EURUSD', active: true, order: 0, digits: 5 },
    { _id: new ObjectId(), name: 'XAUUSD', active: true, order: 1, digits: 2 },
  ]);
});
after(async () => {
  server.close();
  await client.close();
  await mongo.stop();
});

describe('timeframe per pair', () => {
  it('tells the EA each pair\'s timeframe, before the last candle times', async () => {
    const r = await call('/api/ea/mt4/symbols', ea);
    assert.deepEqual(r.body.tf, { EURUSD: 1440, XAUUSD: 240 });
    const text = JSON.stringify(r.body);
    assert.ok(text.indexOf('"tf"') < text.indexOf('"last"'));
  });

  it('stores H4 and D1 candles apart and drops the H4 bar still open', async () => {
    const h4 = sampleCandles('XAUUSD', 2400, 300, NOW, 'H4');
    const open = { t: NOW / 1000 - 2.5 * 3600, o: 2400, h: 2401, l: 2399, c: 2400 }; // 08:00 bar
    const r = await call('/api/ea/mt4/candles', ea, 'POST', { symbol: 'XAUUSD', digits: 2, tf: 240, now: NOW / 1000, candles: [...asEa(h4), open] });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.stored, r.body.ignoredOpen, r.body.tf], [300, 1, 'H4']);
    // an EA before 1.20 sends D1 (no tf): kept in the D1 collection, the H4 analysis stays
    const d1 = sampleCandles('XAUUSD', 2400, 30, NOW, 'D1');
    await call('/api/ea/mt4/candles', ea, 'POST', { symbol: 'XAUUSD', digits: 2, now: NOW / 1000, candles: asEa(d1) });
    await call('/api/ea/mt4/candles', ea, 'POST', { symbol: 'EURUSD', digits: 5, now: NOW / 1000, candles: asEa(sampleCandles('EURUSD', 1.09, 300, NOW, 'D1')) });
    assert.equal(await db.candlesH4.countDocuments({ symbol: 'XAUUSD' }), 300);
    assert.equal(await db.candles.countDocuments({ symbol: 'XAUUSD' }), 30);
    assert.equal(await db.candlesH4.countDocuments({ symbol: 'EURUSD' }), 0);
    const a = await db.analyses.findOne({ _id: 'XAUUSD' });
    assert.equal(a?.timeframe, 'H4');
    assert.equal(a?.lastCandleAt.getTime(), h4.at(-1)!.t.getTime());
    const last = (await call('/api/ea/mt4/symbols', ea)).body.last;
    assert.equal(last.XAUUSD, h4.at(-1)!.t.getTime() / 1000);
  });

  it('serves the analysis, the pair list and the backtest on each pair\'s timeframe', async () => {
    const x = (await call('/api/analysis/XAUUSD', web)).body;
    assert.equal(x.timeframe, 'H4');
    assert.equal(x.candles.at(-1).t - x.candles.at(-2).t, H4);
    assert.equal((await call('/api/analysis/EURUSD', web)).body.timeframe, 'D1');
    const list = (await call('/api/symbols', web)).body.symbols;
    assert.deepEqual(list.map((s: { name: string; timeframe: string; minSlPips: number }) => [s.name, s.timeframe, s.minSlPips]), [['EURUSD', 'D1', 15], ['XAUUSD', 'H4', 0]]);
    const bt = (await call('/api/backtest/candles', web)).body;
    const gold = bt.symbols.find((s: { name: string }) => s.name === 'XAUUSD');
    assert.equal(gold.timeframe, 'H4');
    assert.equal(gold.candles.length, 300);
    assert.equal(gold.inputs.minSlPips, 0);
  });

  it('switches a pair\'s timeframe from the settings and re-analyses it', async () => {
    const r = await call('/api/symbols', web, 'PUT', [{ name: 'EURUSD', active: true }, { name: 'XAUUSD', active: true, timeframe: 'D1' }]);
    assert.equal(r.status, 200);
    const a = await db.analyses.findOne({ _id: 'XAUUSD' });
    assert.equal(a?.timeframe, 'D1');
    const x = (await call('/api/analysis/XAUUSD', web)).body;
    assert.equal(x.candles.length, 30);
    assert.equal((await call('/api/ea/mt4/symbols', ea)).body.tf.XAUUSD, 1440);
    // back to H4 for the next tests
    await call('/api/symbols', web, 'PUT', [{ name: 'EURUSD', active: true }, { name: 'XAUUSD', active: true, timeframe: 'H4' }]);
    assert.equal((await db.analyses.findOne({ _id: 'XAUUSD' }))?.timeframe, 'H4');
  });

  it('keeps cancels within one H4 bar and resets them on the next', async () => {
    const a = (await db.analyses.findOne({ _id: 'XAUUSD' }))!;
    const id = a.candidates.find((c) => !c.skipped)!.id;
    await db.analyses.updateOne({ _id: 'XAUUSD' }, { $set: { cancelled: [id] } });
    const last = a.lastCandleAt.getTime();
    const bar = { t: (last + H4) / 1000, o: 2400, h: 2402, l: 2398, c: 2401 };
    await call('/api/ea/mt4/candles', ea, 'POST', { symbol: 'XAUUSD', tf: 240, now: (last + 2 * H4) / 1000, candles: [bar] });
    const next = (await db.analyses.findOne({ _id: 'XAUUSD' }))!;
    assert.equal(next.lastCandleAt.getTime(), last + H4);
    assert.deepEqual(next.cancelled, []);
  });
});
