import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import type { AccountDoc } from './db.ts';
import { isAffected, parseForexFactory, type Aggressive } from './news.ts';
import { multiplierFor } from './service.ts';

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
