import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayStart, parseCandleCsv } from './candleCsv.ts';

const t = (d: string) => dayStart(d);

describe('parseCandleCsv', () => {
  it('reads the MT4 History Center export (no header, date and time columns)', () => {
    const r = parseCandleCsv('2020.01.02,00:00,1.1,1.12,1.09,1.11,1234\n2020.01.03,00:00,1.11,1.13,1.1,1.12,999\n');
    assert.deepEqual(r.candles, [
      { t: t('2020-01-02'), o: 1.1, h: 1.12, l: 1.09, c: 1.11 },
      { t: t('2020-01-03'), o: 1.11, h: 1.13, l: 1.1, c: 1.12 },
    ]);
  });

  it('reads a headed semicolon file with an ISO time', () => {
    const r = parseCandleCsv('time;open;high;low;close;volume\n2020-01-02T00:00:00;1.1;1.12;1.09;1.11;5\n');
    assert.equal(r.candles.length, 1);
    assert.equal(r.skipped, 1); // the header
  });

  it('reads compact HistData dates and dd.mm.yyyy', () => {
    assert.equal(parseCandleCsv('20200102 000000;1.1;1.2;1.0;1.1;0\n').candles[0]!.t, t('2020-01-02'));
    assert.equal(parseCandleCsv('02.01.2020 00:00:00.000,1.1,1.2,1.0,1.1,0\n').candles[0]!.t, t('2020-01-02'));
  });

  it('folds intraday rows into one day', () => {
    const r = parseCandleCsv(['2020-01-02,00:00,1.10,1.12,1.09,1.11', '2020-01-02,01:00,1.11,1.15,1.10,1.14', '2020-01-02,02:00,1.14,1.14,1.05,1.06'].join('\n'));
    assert.deepEqual(r.candles, [{ t: t('2020-01-02'), o: 1.1, h: 1.15, l: 1.05, c: 1.06 }]);
  });

  it('drops weekends unless asked and counts them', () => {
    const csv = '2020-01-04,00:00,1.1,1.2,1.0,1.1\n2020-01-06,00:00,1.1,1.2,1.0,1.1\n';
    const r = parseCandleCsv(csv);
    assert.deepEqual(r.candles.map((c) => c.t), [t('2020-01-06')]);
    assert.equal(r.weekends, 1);
    assert.equal(parseCandleCsv(csv, { weekends: true }).candles.length, 2);
  });

  it('skips inconsistent rows and honours from/until', () => {
    const csv = ['2020-01-06,1.1,1.0,1.2,1.1', '2020-01-07,1.1,1.2,1.0,1.1', '2020-01-08,1.1,1.2,1.0,1.1', '2020-01-09,1.1,1.2,1.0,1.1'].join('\n');
    const r = parseCandleCsv(csv, { from: t('2020-01-08'), until: t('2020-01-08') });
    assert.deepEqual(r.candles.map((c) => c.t), [t('2020-01-08')]);
    assert.equal(r.skipped, 1); // high below low
  });

  it('reports an unreadable file', () => {
    assert.ok(parseCandleCsv('hello\nworld\n').error);
  });
});
