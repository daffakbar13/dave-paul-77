import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultMinSlPips, parseTpl } from './lines.ts';

const TPL = [
  '<chart>', 'id=1', 'symbol=EURUSD', 'period=1440', '<window>', '<indicator>', 'name=main',
  '<object>', 'type=1', 'object_name=Horizontal Line 1', 'value_0=1.166465', '</object>',
  '<object>', 'type=2', 'object_name=Trendline', 'value_0=1.2', 'value_1=1.3', '</object>',
  '<object>', 'type=1', 'object_name=Horizontal Line 2', 'value_0=1.161572', '</object>',
  '<object>', 'type=1', 'object_name=dup', 'value_0=1.161572', '</object>',
  '</indicator>', '</window>', '</chart>',
].join('\r\n');

describe('parseTpl', () => {
  it('reads the symbol and only horizontal lines, sorted and unique', () => {
    assert.deepEqual(parseTpl(TPL), { symbol: 'EURUSD', period: 1440, lines: [1.161572, 1.166465] });
  });

  it('rejects files that are not chart templates', () => {
    assert.equal(parseTpl('hello'), null);
  });
});

describe('defaultMinSlPips', () => {
  it('follows the previous tool and falls back to 15', () => {
    assert.equal(defaultMinSlPips('nzdusd'), 10);
    assert.equal(defaultMinSlPips('GBPJPY'), 20);
    assert.equal(defaultMinSlPips('XAUUSD'), 30);
    assert.equal(defaultMinSlPips('EURCAD'), 15);
  });
});
