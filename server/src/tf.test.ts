import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { collections, ensureIndexes, type Collections } from './db.ts';
import { seedSample } from './sample.ts';
import { markDay, tfOrders } from './tf.ts';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Collections;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = collections(client.db('tf_test'));
  await ensureIndexes(db);
  await seedSample(db);
});
after(async () => {
  await client.close();
  await mongo.stop();
});

describe('tfOrders', () => {
  it('lists the analysis stops on the right side of price, whatever the EA holds', async () => {
    const account = (await db.accounts.findOne({ name: 'Demo A' }))!;
    const { rows } = await tfOrders(db, account);
    assert.ok(rows.some((r) => r.side === 'buy') && rows.some((r) => r.side === 'sell'));
    for (const r of rows) {
      const q = (await db.quotes.findOne({ _id: r.symbol }))!;
      assert.ok(r.side === 'buy' ? r.entry > q.ask : r.entry < q.bid, `${r.id} ${r.entry}`);
    }
  });

  it('keeps a level whose MT5 position is running', async () => {
    const account = (await db.accounts.findOne({ name: 'Demo A' }))!;
    const before = await tfOrders(db, account);
    const buy = before.rows.find((r) => r.symbol === 'EURUSD' && r.side === 'buy')!;
    const withPosition = { ...account, positions: [{ ticket: 7, symbol: 'EURUSD', side: 'buy' as const, volume: 0.1, openPrice: buy.entry, sl: buy.sl, tp: buy.tp, comment: buy.id }] };
    const { rows } = await tfOrders(db, withPosition);
    assert.ok(rows.some((r) => r.id === buy.id));
  });

  it('drops a level once price is past its entry', async () => {
    const account = (await db.accounts.findOne({ name: 'Demo A' }))!;
    const buys = (await tfOrders(db, account)).rows.filter((r) => r.symbol === 'EURUSD' && r.side === 'buy').sort((a, b) => a.entry - b.entry);
    const q = (await db.quotes.findOne({ _id: 'EURUSD' }))!;
    // price jumps just above the nearest buy entry; the analysis keeps its lines for 5 minutes
    await db.quotes.updateOne({ _id: 'EURUSD' }, { $set: { bid: buys[0]!.entry + 0.00001, ask: buys[0]!.entry + 0.00002 } });
    const { rows } = await tfOrders(db, account);
    assert.ok(!rows.some((r) => r.id === buys[0]!.id));
    await db.quotes.updateOne({ _id: 'EURUSD' }, { $set: { bid: q.bid, ask: q.ask } });
  });
});

describe('markDay', () => {
  it('starts a new day at 05:00 WIB (22:00 UTC)', () => {
    assert.equal(markDay(new Date('2026-11-16T21:59:59Z')), '2026-11-16');
    assert.equal(markDay(new Date('2026-11-16T22:00:00Z')), '2026-11-17');
    assert.equal(markDay(new Date('2026-11-17T04:00:00Z')), '2026-11-17'); // 11:00 WIB
  });
});
