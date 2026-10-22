import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_CALENDAR, needsRefresh, parseForexFactory, type Calendar } from './calendar.ts';

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

  it('30 minutes after an error, never before a rate-limit retry time', () => {
    const err = { ...ok(5 * H), attemptedAt: at(now - 20 * 60_000), error: 'HTTP 503' };
    assert.equal(needsRefresh(err, now), false);
    assert.equal(needsRefresh({ ...err, attemptedAt: at(now - 30 * 60_000) }, now), true);
    assert.equal(needsRefresh({ ...err, attemptedAt: at(now - H), retryAt: at(now + 60_000) }, now), false);
  });
});
