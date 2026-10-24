import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { peakOpen, closedInOrder, csvDate, csvPrice, drawdown, monthTable, overall, streaks, tradesCsv, gradeOf, type BtTrade } from './backtestStats.ts';

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
  });
});

describe('drawdown and grade', () => {
  it('measures the largest fall from a peak', () => {
    const dd = drawdown([{ t: 1, balance: 100 }, { t: 2, balance: 150 }, { t: 3, balance: 90 }, { t: 4, balance: 140 }]);
    assert.deepEqual(dd, { amount: 60, pct: 40 });
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
