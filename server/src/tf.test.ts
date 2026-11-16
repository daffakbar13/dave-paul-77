import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { collections, ensureIndexes, type AccountDoc, type Collections, type TradeDoc } from './db.ts';
import { markDay, sentOrders } from './tf.ts';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Collections;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = collections(client.db('tf_test'));
  await ensureIndexes(db);
});
after(async () => {
  await client.close();
  await mongo.stop();
});
beforeEach(async () => {
  await db.trades.deleteMany({});
  await db.commands.deleteMany({});
});

const accountId = new ObjectId();
const account = (positions: AccountDoc['positions'] = []) => ({ _id: accountId, number: 1, positions }) as unknown as AccountDoc;

function trade(ticket: number, ref: string, status: TradeDoc['status'], entry = 1.1): TradeDoc {
  const now = new Date();
  return {
    _id: new ObjectId(), accountId, accountNumber: 1, ticket, ref, symbol: ref.split(':')[0]!, side: 'buy', deals: [],
    plan: {
      commandId: 'c', placedAt: now, aggressive: 'off', line: entry, lineSource: 'auto', entry, sl: entry - 0.002, tp: entry + 0.004,
      tpAuto: false, lot: 0.1, risk: 10, rr: 2, multiplier: 1, atr: null, newsAffected: false,
    },
    status, openedAt: null, openPrice: null, volume: 0, closedAt: null, closePrice: null, closeReason: null, profit: 0, costs: 0, net: 0,
    createdAt: now, updatedAt: now,
  };
}

describe('sentOrders', () => {
  it('lists placed orders as pending and skips cancelled and closed ones', async () => {
    await db.trades.insertMany([trade(1, 'EURUSD:a', 'placed'), trade(2, 'EURUSD:b', 'cancelled'), trade(3, 'EURUSD:c', 'closed')]);
    const { rows } = await sentOrders(db, account());
    assert.deepEqual(rows.map((r) => [r.id, r.status, r.type]), [['EURUSD:a', 'valid', 'buy stop']]);
  });

  it('shows a placed order whose position is open as running, with the plan prices', async () => {
    await db.trades.insertOne(trade(5, 'EURUSD:a', 'placed', 1.2));
    const { rows } = await sentOrders(db, account([{ ticket: 5, symbol: 'EURUSD', side: 'buy', volume: 0.1, openPrice: 1.2003, sl: 1.198, tp: 1.204, comment: '' }]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'running');
    assert.equal(rows[0]!.entry, 1.2);
  });

  it('keeps an open position without a journal entry, priced from the broker', async () => {
    const { rows } = await sentOrders(db, account([
      { ticket: 9, symbol: 'GBPUSD', side: 'sell', volume: 0.2, openPrice: 1.3, sl: 1.302, tp: 1.296, comment: '' },
      { ticket: 10, symbol: 'GBPUSD', side: 'buy', volume: 0.2, openPrice: 1.3, sl: 0, tp: 0, comment: '' },
    ]));
    assert.deepEqual(rows.map((r) => [r.id, r.type, r.entry, r.sl, r.tp]), [['pos:9', 'sell stop', 1.3, 1.302, 1.296]]);
  });
});

describe('markDay', () => {
  it('starts a new day at 05:00 WIB (22:00 UTC)', () => {
    assert.equal(markDay(new Date('2026-11-16T21:59:59Z')), '2026-11-16');
    assert.equal(markDay(new Date('2026-11-16T22:00:00Z')), '2026-11-17');
    assert.equal(markDay(new Date('2026-11-17T04:00:00Z')), '2026-11-17'); // 11:00 WIB
  });
});
