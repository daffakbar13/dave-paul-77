import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { compound, toRaw } from './backtest.ts';
import { peakOpen, peakOpenDay, closedInOrder, csvDate, csvPrice, drawdown, monthReturns, monthTable, overall, streaks, tradesCsv, gradeOf, type BtTrade } from './backtestStats.ts';

const DAY = 86_400_000;
const day = (s: string) => Date.parse(`${s}T00:00:00Z`);

const trade = (t: Partial<BtTrade>): BtTrade => ({
  symbol: 'EURUSD', side: 'buy', entryAt: day('2024-01-02'), exitAt: day('2024-01-03'), entry: 1.1, tp: 1.102, sl: 1.099,
  result: 'TP', tpPips: 20, slPips: 10, pips: 20, r: 2, riskMoney: 60, profit: 120, balanceBefore: 6000, ambiguous: false, digits: 5, ...t,
});

describe('csv helpers', () => {
  it('formats dates and prices like the reference file', () => {
    assert.equal(csvDate(day('2024-01-02')), '02-Jan-2024');
    assert.equal(csvPrice(1.094), '1.094');
    assert.equal(csvPrice(1.0930300), '1.09303');
    assert.equal(csvPrice(1.1234567), '1.123457');
  });

  it('writes semicolon rows in entry order and leaves the exit of an open trade empty', () => {
    const csv = tradesCsv([
      trade({ symbol: 'GBPUSD', side: 'sell', entryAt: day('2024-01-05'), result: 'Open', exitAt: null }),
      trade({ result: 'SL', pips: -10, r: -1, profit: -60 }),
    ]);
    assert.equal(
      csv,
      'Pair;Action;Tanggal Entry;Tanggal Exit;Entry;TP;SL;Keterangan\r\n' +
        'EURUSD;Buy;02-Jan-2024;03-Jan-2024;1.1;1.102;1.099;SL\r\n' +
        'GBPUSD;Sell;05-Jan-2024;;1.1;1.102;1.099;Open\r\n',
    );
  });

  it('the detail export adds money columns', () => {
    const head = tradesCsv([trade({})], true).split('\r\n')[0]!;
    assert.match(head, /;Pips;R;Risiko;Profit;Balance Awal Hari;Ambigu$/);
  });
});

describe('overall', () => {
  it('counts wins, pips and the monthly averages', () => {
    const trades = [
      trade({ exitAt: day('2024-01-10'), pips: 20, profit: 100 }),
      trade({ result: 'SL', exitAt: day('2024-03-05'), pips: -10, r: -1, profit: -50 }),
    ];
    const o = overall(trades, 1000);
    assert.equal(o.trades, 2);
    assert.equal(o.probability, 0.5);
    assert.equal(o.profit, 50);
    assert.equal(o.profitPct, 5);
    assert.equal(o.months, 3); // Jan..Mar
    assert.equal(o.years, 1);
    assert.equal(o.avgPipsMonth, 3.3);
    assert.equal(o.riskReward, 0.5);
    assert.equal(o.profitFactor, 2);
  });

  it('ignores open trades in the numbers and reports them', () => {
    const o = overall([trade({}), trade({ result: 'Open', exitAt: null, pips: 0, profit: 0 })], 6000);
    assert.equal(o.trades, 1);
    assert.equal(o.open, 1);
  });

  it('is empty-safe', () => {
    const o = overall([], 6000);
    assert.equal(o.trades, 0);
    assert.equal(o.probability, null);
    assert.equal(o.months, 0);
  });
});

describe('streaks', () => {
  const seq = (pips: number[]) =>
    pips.map((p, i) => trade({ entryAt: i * DAY, exitAt: i * DAY + 1, pips: p, result: p > 0 ? 'TP' : 'SL' }));

  it('longest by count and best by pips can be different runs', () => {
    // wins: +1 +1 +1 (3 trades, 3 pips) and +50 +60 (2 trades, 110 pips)
    const s = streaks(seq([1, 1, 1, -5, 50, 60, -5]), 1);
    assert.deepEqual(s.byTrade, { count: 3, pips: 3 });
    assert.deepEqual(s.byPips, { count: 2, pips: 110 });
  });

  it('losses use the most negative run', () => {
    const s = streaks(seq([10, -5, -5, 10, -30, -40, 10]), -1);
    // two runs of 2 losses: a tie on count goes to the deeper one
    assert.deepEqual(s.byTrade, { count: 2, pips: -70 });
    assert.deepEqual(s.byPips, { count: 2, pips: -70 });
  });
});

describe('peakOpen', () => {
  it('counts overlapping trades, the exit day included', () => {
    const t = [
      trade({ entryAt: 0, exitAt: 2 * DAY }),
      trade({ entryAt: DAY, exitAt: DAY }),
      trade({ entryAt: 2 * DAY, exitAt: 3 * DAY }),
      trade({ entryAt: 3 * DAY, exitAt: null, result: 'Open' }),
    ];
    assert.equal(peakOpen(t), 2); // days: 0 -> 1, 1 -> 2 (1+2), 2 -> 2 (1+3), 3 -> 2 (3 + the open one)
    assert.deepEqual(peakOpenDay(t), { count: 2, at: DAY }); // first reached on day 1
    assert.deepEqual(peakOpenDay([]), { count: 0, at: null });
  });
});

describe('monthReturns (Persentase)', () => {
  it('month = profit over the balance at the start of the month; YTD compounds; Total = final / initial', () => {
    const t = monthReturns(
      [
        trade({ exitAt: day('2024-01-10'), profit: 100 }), // Jan: 1000 -> 1100 = +10%
        trade({ exitAt: day('2024-03-05'), profit: -55, result: 'SL' }), // Mar: 1100 -> 1045 = -5%
        trade({ exitAt: day('2024-03-20'), profit: 0 }),
        trade({ exitAt: day('2025-02-01'), profit: 209 }), // Feb 2025: 1045 -> 1254 = +20%
        trade({ result: 'Open', exitAt: null, profit: 0 }),
      ],
      1000,
    );
    assert.deepEqual(t.rows[0]!.months, [10, null, -5, null, null, null, null, null, null, null, null, null]);
    assert.equal(t.rows[0]!.ytd, 4.5); // 1.10 x 0.95 - 1
    assert.equal(t.rows[1]!.year, 2025);
    assert.equal(t.rows[1]!.months[1], 20);
    assert.equal(t.rows[1]!.ytd, 20);
    assert.equal(t.total, 25.4); // 1254 / 1000 - 1
  });

  it('is empty-safe', () => {
    assert.deepEqual(monthReturns([], 1000), { rows: [], total: 0 });
  });
});

describe('toRaw', () => {
  it('drops the money so compound() can apply another balance without a replay', () => {
    const raw = [
      { ...trade({ entryAt: day('2024-01-02'), exitAt: day('2024-01-02'), r: 2 }) },
      { ...trade({ entryAt: day('2024-01-03'), exitAt: day('2024-01-04'), r: -1, result: 'SL' as const, pips: -10 }) },
    ];
    const once = compound(toRaw(raw), 1000, 1);
    assert.deepEqual(once.map((t) => t.profit), [20, -10.2]); // the second trade is sized on 1020
    assert.equal(Object.hasOwn(toRaw(once)[0]!, 'profit'), false);
    assert.deepEqual(compound(toRaw(compound(toRaw(raw), 5000, 2)), 1000, 1), once);
  });
});

describe('drawdown and grade', () => {
  it('measures the largest fall from a peak', () => {
    const dd = drawdown([{ t: 1, balance: 100 }, { t: 2, balance: 150 }, { t: 3, balance: 90 }, { t: 4, balance: 140 }]);
    assert.equal(dd.amount, 60);
    assert.equal(dd.pct, 40);
    assert.deepEqual(dd.byAmount, { amount: 60, pct: 40, peakAt: 2, troughAt: 3, recoveredAt: null });
    assert.deepEqual(dd.byPct, dd.byAmount);
  });

  it('the deepest fall in money and in % can be different episodes, each with its dates', () => {
    // early: 100 -> 50 (-50, -50%), recovered at t=4; later: 1000 -> 800 (-200, -20%), not recovered
    const dd = drawdown([
      { t: 1, balance: 100 }, { t: 2, balance: 50 }, { t: 3, balance: 80 }, { t: 4, balance: 100 },
      { t: 5, balance: 1000 }, { t: 6, balance: 900 }, { t: 7, balance: 800 }, { t: 8, balance: 950 },
    ]);
    assert.equal(dd.amount, 200);
    assert.equal(dd.pct, 50);
    assert.deepEqual(dd.byAmount, { amount: 200, pct: 20, peakAt: 5, troughAt: 7, recoveredAt: null });
    assert.deepEqual(dd.byPct, { amount: 50, pct: 50, peakAt: 1, troughAt: 2, recoveredAt: 4 });
  });

  it('a curve that only rises has no drawdown', () => {
    assert.deepEqual(drawdown([{ t: 1, balance: 100 }, { t: 2, balance: 120 }]), { amount: 0, pct: 0, byAmount: null, byPct: null });
  });

  it('overall reports both episodes', () => {
    const o = overall(
      [
        trade({ entryAt: day('2024-01-02'), exitAt: day('2024-01-05'), profit: -100, result: 'SL', pips: -10, r: -1 }),
        trade({ entryAt: day('2024-02-01'), exitAt: day('2024-02-03'), profit: 300 }),
      ],
      1000,
    );
    assert.equal(o.maxDrawdown, 100);
    assert.equal(o.maxDrawdownPct, 10);
    assert.deepEqual(o.maxDrawdownByAmount, { amount: 100, pct: 10, peakAt: day('2024-01-02'), troughAt: day('2024-01-05'), recoveredAt: day('2024-02-03') });
  });

  it('few trades never get a verdict', () => {
    assert.equal(gradeOf(10, 0.9, 3), 'few');
    assert.equal(gradeOf(100, 0.3, 1.8), 'good');
    assert.equal(gradeOf(100, 0.05, 1.1), 'ok');
    assert.equal(gradeOf(100, -0.1, 0.9), 'weak');
  });
});

// The reference file the summary screens were made from. It lives in the gitignored
// ea/local folder; without it these checks are skipped.
const SAMPLE = new URL('../../../ea/local/backtest-template-v2.csv', import.meta.url);
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const parseDate = (s: string) => {
  const [d, m, y] = s.split('-') as [string, string, string];
  return Date.UTC(Number(y), MONTHS[m]!, Number(d));
};

function sampleTrades(): BtTrade[] {
  const rows = readFileSync(SAMPLE, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(';'));
  return rows.map(([pair, action, inD, outD, entry, tp, sl, result]) => {
    const e = Number(entry);
    const t = Number(tp);
    const s = Number(sl);
    const tpPips = Math.abs(t - e) * 10_000;
    const slPips = Math.abs(e - s) * 10_000;
    const win = result === 'TP';
    return trade({
      symbol: pair!, side: action === 'Buy' ? 'buy' : 'sell', entryAt: parseDate(inD!), exitAt: parseDate(outD!), entry: e, tp: t, sl: s,
      result: win ? 'TP' : 'SL', tpPips, slPips, pips: win ? tpPips : -slPips, r: slPips ? (win ? tpPips : -slPips) / slPips : 0,
    });
  });
}

describe('reference file', { skip: !existsSync(SAMPLE) }, () => {
  it('reproduces the Overall screen', () => {
    const o = overall(sampleTrades(), 6000);
    assert.equal(o.trades, 167);
    assert.equal(Math.round((o.probability ?? 0) * 10_000) / 100, 57.49);
    assert.equal(o.pips, 3148.8);
    assert.equal(o.avgPipsTrade, 18.9);
    assert.equal(o.avgPipsMonth, 196.8);
    assert.equal(o.avgPipsYear, 1574.4);
    assert.equal(o.months, 16);
    assert.equal(o.years, 2);
    assert.equal(o.riskReward, 0.46);
    assert.deepEqual(o.consecutiveProfit.byTrade.count, 7);
    assert.deepEqual(o.consecutiveProfit.byTrade.pips, 339.8);
    assert.deepEqual(o.consecutiveProfit.byPips, { count: 5, pips: 364 });
    assert.deepEqual(o.consecutiveLoss.byTrade, { count: 4, pips: -79.69 });
    assert.deepEqual(o.consecutiveLoss.byPips, { count: 4, pips: -79.69 });
  });

  it('reproduces the Per Month screen', () => {
    const t = monthTable(sampleTrades(), (x) => x.pips);
    const y24 = t.rows.find((r) => r.year === 2024)!;
    const y25 = t.rows.find((r) => r.year === 2025)!;
    assert.deepEqual(y24.months, [29.8, 52.8, 31.8, 197.2, 31.3, 146.1, 27.2, 318.1, 137.7, 88.4, 351.4, 201]);
    assert.equal(y24.ytd, 1612.8);
    assert.deepEqual(y25.months, [382, 204.6, 267.9, 681.6, null, null, null, null, null, null, null, null]);
    assert.equal(y25.ytd, 1536);
    assert.equal(t.total, 3148.8);
  });

  it('closedInOrder keeps every trade', () => {
    assert.equal(closedInOrder(sampleTrades()).length, 167);
  });
});
