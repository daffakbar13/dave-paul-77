// Loads older D1 history from price CSV files into the backend, for the years the MT4
// terminal does not have. Posts to the same endpoint as the MT4 data EA (upsert, so
// running it twice is harmless), in chunks, without recomputing the live analysis.
//
//   node scripts/import-candles.ts --url http://localhost:4000 --key <data key> \
//        --until 2024-10-15 EURUSD.csv GBPUSD_H1.csv
//
// --symbol NAME   pair of the single file (default: first 6-letter name in the file name)
// --digits N      decimals of the pair (default: the backend's guess)
// --from/--until  YYYY-MM-DD limits; use --until the day before the first MT4 candle so
//                 the CSV never overwrites broker data (sources differ in day cut-off)
// --weekends      keep Saturday/Sunday candles (dropped by default)
// --dry           parse and report only
// URL and key default to SERVER_URL and EA_DATA_KEY.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { dayStart, parseCandleCsv } from '../src/analysis/candleCsv.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    key: { type: 'string' },
    symbol: { type: 'string' },
    digits: { type: 'string' },
    from: { type: 'string' },
    until: { type: 'string' },
    weekends: { type: 'boolean', default: false },
    dry: { type: 'boolean', default: false },
  },
});

if (!positionals.length) {
  console.error('Usage: node scripts/import-candles.ts [--url U --key K --until YYYY-MM-DD ...] file.csv [more.csv]');
  process.exit(1);
}
if (values.symbol && positionals.length > 1) {
  console.error('--symbol only works with one file');
  process.exit(1);
}
const url = (values.url ?? process.env.SERVER_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const key = values.key ?? process.env.EA_DATA_KEY ?? '';
if (!values.dry && !key) {
  console.error('Missing data key: pass --key or set EA_DATA_KEY');
  process.exit(1);
}
const CHUNK = 1000;

for (const file of positionals) {
  const symbol = (values.symbol ?? /[A-Za-z]{6}/.exec(basename(file))?.[0] ?? '').toUpperCase();
  if (!symbol) {
    console.error(`${file}: cannot tell the pair, pass --symbol`);
    process.exitCode = 1;
    continue;
  }
  const r = parseCandleCsv(readFileSync(file, 'utf8'), {
    weekends: values.weekends,
    ...(values.from ? { from: dayStart(values.from) } : {}),
    ...(values.until ? { until: dayStart(values.until) } : {}),
  });
  if (r.error) {
    console.error(`${file}: ${r.error}`);
    process.exitCode = 1;
    continue;
  }
  const first = new Date(r.candles[0]!.t * 1000).toISOString().slice(0, 10);
  const last = new Date(r.candles.at(-1)!.t * 1000).toISOString().slice(0, 10);
  console.log(`${symbol}: ${r.candles.length} days ${first}..${last} (${r.rows} rows, ${r.skipped} skipped, ${r.weekends} weekend rows dropped)`);
  if (values.dry) continue;
  for (let i = 0; i < r.candles.length; i += CHUNK) {
    const res = await fetch(`${url}/api/ea/mt4/candles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'ngrok-skip-browser-warning': '1' },
      body: JSON.stringify({
        symbol,
        ...(values.digits ? { digits: Number(values.digits) } : {}),
        now: Math.floor(Date.now() / 1000),
        backfill: true,
        candles: r.candles.slice(i, i + CHUNK),
      }),
    });
    if (!res.ok) {
      console.error(`${symbol}: HTTP ${res.status} ${await res.text()}`);
      process.exitCode = 1;
      break;
    }
  }
}
