import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { collections, ensureIndexes, type AccountDoc, type CommandDoc, type Collections } from './db.ts';
import { journalFor, recordDeals, recordPlacements, type IncomingDeal } from './journal.ts';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Collections;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = collections(client.db('journal_test'));
  await ensureIndexes(db);
});
after(async () => {
  await client.close();
  await mongo.stop();
});

const account = { _id: new ObjectId(), number: 123, symbolMap: {}, currency: 'USD' } as unknown as AccountDoc;

function command(refs: string[], tickets: number[], at: string): CommandDoc {
  const createdAt = new Date(at);
  return {
    _id: new ObjectId(), accountId: account._id, accountNumber: 123, aggressive: 'auto', status: 'done', createdAt, finishedAt: createdAt,
    expiresAt: createdAt, purgeAt: createdAt, dryRun: false,
    orders: refs.map((ref) => ({ ref, symbol: ref.split(':')[0]!, side: 'buy', entry: 1.1, sl: 1.098, tp: 1.104, lot: 0.5 })),
    plans: refs.map((ref) => ({
      ref, aggressive: 'auto', line: 1.0995, lineSource: 'auto', entry: 1.1, sl: 1.098, tp: 1.104, tpAuto: false, slFrom: 'candle',
      lot: 0.5, risk: 100, rr: 2, multiplier: 1, atr: 0.008, newsAffected: false,
    })),
    results: refs.map((ref, i) => ({ ref, ok: true, ticket: tickets[i]! })),
  };
}

const deal = (d: Partial<IncomingDeal>): IncomingDeal => ({
  ticket: 1, order: 501, position: 501, time: new Date('2026-11-03T08:00:00Z'), symbol: 'EURUSD', side: 'buy', entry: 'in', reason: 'expert',
  volume: 0.5, price: 1.1002, sl: 1.098, tp: 1.104, profit: 0, commission: -2, swap: 0, fee: 0, comment: 'EURUSD:buy-1.09950', ...d,
});

describe('trade journal', () => {
  it('placement, fill, close, and the November audit', async () => {
    await db.commands.insertOne(command(['EURUSD:buy-1.09950', 'EURUSD:buy-1.10500'], [501, 502], '2026-11-02T01:00:00Z'));
    const first = (await db.commands.findOne({ 'results.ticket': 501 }))!;
    assert.equal(await recordPlacements(db, first), 2);

    await recordDeals(db, account, [deal({})]);
    const exit = deal({ ticket: 2, order: 600, entry: 'out', side: 'sell', reason: 'tp', price: 1.104, profit: 190, time: new Date('2026-11-05T10:00:00Z') });
    await recordDeals(db, account, [exit]);
    await recordDeals(db, account, [exit]); // a resend changes nothing

    // next day's command: 502 never filled, so it is cancelled
    const second = command(['EURUSD:buy-1.11000'], [503], '2026-11-06T01:00:00Z');
    await db.commands.insertOne(second);
    await recordPlacements(db, second);

    const t501 = (await db.trades.findOne({ ticket: 501 }))!;
    assert.equal(t501.status, 'closed');
    assert.equal(t501.deals.length, 2);
    assert.equal(t501.net, 186); // 190 profit, 2 x -2 commission
    assert.equal(t501.plan?.slFrom, 'candle');
    assert.equal((await db.trades.findOne({ ticket: 502 }))!.status, 'cancelled');
    assert.equal((await db.trades.findOne({ ticket: 503 }))!.status, 'placed');

    const nov = await journalFor(db, account._id, new Date('2026-10-31T17:00:00Z'), new Date('2026-11-30T17:00:00Z'));
    assert.equal(nov.trades.length, 1);
    assert.equal(nov.trades[0]!.r, 1.86);
    assert.equal(nov.audit.stats.net, 186);
    assert.deepEqual(nov.audit.fills, { placed: 3, filled: 1, cancelled: 1, rate: 1 / 3 });
    assert.ok(Math.abs(nov.audit.avgSlipR! - 0.1) < 1e-9); // 2 points worse on a 20-point risk
  });

  it('a position placed before the journal gets its plan from the command, or none', async () => {
    await db.commands.insertOne(command(['GBPUSD:buy-1.30000'], [700], '2026-11-07T01:00:00Z')); // result never recorded as placement
    await recordDeals(db, account, [deal({ ticket: 10, order: 700, position: 700, symbol: 'GBPUSD', comment: 'GBPUSD:buy-1.30000' })]);
    const linked = (await db.trades.findOne({ ticket: 700 }))!;
    assert.equal(linked.status, 'open');
    assert.equal(linked.ref, 'GBPUSD:buy-1.30000');
    assert.equal(linked.plan?.risk, 100);

    await recordDeals(db, account, [deal({ ticket: 11, order: 800, position: 800, symbol: 'AUDJPY', side: 'sell', comment: '' })]);
    const orphan = (await db.trades.findOne({ ticket: 800 }))!;
    assert.equal(orphan.plan, null);
    assert.equal(orphan.side, 'sell');
  });
});
