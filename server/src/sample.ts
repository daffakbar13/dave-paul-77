// Sample data for stage 1 (before the MT4 EA sends real candles): synthetic D1 candles
// with repeating swings so S/R lines appear, quotes, and two demo accounts with symbol
// specs as the MT5 EA would report them for a USD account.
import { ObjectId } from 'mongodb';
import type { SymbolSpec } from './analysis/types.ts';
import { sha256 } from './auth.ts';
import { DEFAULT_SETTINGS, type AccountDoc, type CandleDoc, type Collections } from './db.ts';
import { defaultDigits } from './routes/web.ts';

const DAY = 86_400_000;

// Initial tabs from the MT4 terminal; GBPUSD and XAUUSD exist but start inactive.
export const SAMPLE_SYMBOLS: { name: string; base: number; active: boolean }[] = [
  { name: 'AUDJPY', base: 98.5, active: true },
  { name: 'AUDUSD', base: 0.66, active: true },
  { name: 'CADJPY', base: 108.2, active: true },
  { name: 'CHFJPY', base: 185.4, active: true },
  { name: 'EURGBP', base: 0.86, active: true },
  { name: 'EURNZD', base: 1.92, active: true },
  { name: 'EURUSD', base: 1.09, active: true },
  { name: 'GBPJPY', base: 196.3, active: true },
  { name: 'NZDJPY', base: 90.1, active: true },
  { name: 'NZDUSD', base: 0.6, active: true },
  { name: 'USDCAD', base: 1.37, active: true },
  { name: 'USDCHF', base: 0.8, active: true },
  { name: 'USDJPY', base: 150.2, active: true },
  { name: 'GBPUSD', base: 1.27, active: false },
  { name: 'XAUUSD', base: 2400, active: false },
];

const BASE = new Map(SAMPLE_SYMBOLS.map((s) => [s.name, s.base]));

// Deterministic PRNG so every seed produces the same chart.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// Weekday D1 candles ending yesterday (UTC). Price oscillates around `base` so swing
// highs/lows repeat near the same levels; about one candle in eight is a strong one.
export function sampleCandles(symbol: string, base: number, count: number, now = Date.now()): Omit<CandleDoc, '_id'>[] {
  const rand = mulberry32(hash(symbol));
  const digits = defaultDigits(symbol);
  const vol = base * (symbol.startsWith('XAU') ? 0.012 : 0.008);
  const days: number[] = [];
  let t = Math.floor(now / DAY) * DAY - DAY;
  while (days.length < count) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) days.unshift(t);
    t -= DAY;
  }
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  const out: Omit<CandleDoc, '_id'>[] = [];
  let close = base;
  days.forEach((day, i) => {
    const target = base * (1 + 0.055 * Math.sin((2 * Math.PI * i) / 170 + p1) + 0.025 * Math.sin((2 * Math.PI * i) / 43 + p2));
    const strong = rand() < 0.12;
    const o = close;
    const pull = (target - o) * 0.35;
    const move = pull + (rand() - 0.5) * vol * (strong ? 3.2 : 1.3);
    const c = o + move;
    const wickTop = rand() * vol * (strong ? 0.15 : 0.6);
    const wickBottom = rand() * vol * (strong ? 0.15 : 0.6);
    out.push({
      symbol,
      t: new Date(day),
      o: round(o, digits),
      h: round(Math.max(o, c) + wickTop, digits),
      l: round(Math.min(o, c) - wickBottom, digits),
      c: round(c, digits),
    });
    close = c;
  });
  return out;
}

// tickValue for 1 lot in USD, using the sample prices for conversion.
export function sampleSpec(symbol: string, stopsLevel = 10): SymbolSpec {
  const digits = defaultDigits(symbol);
  const tickSize = 10 ** -digits;
  if (symbol === 'XAUUSD') {
    return { digits, point: tickSize, tickSize, tickValue: 1, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, stopsLevel };
  }
  const quote = symbol.slice(3, 6);
  const valueInQuote = tickSize * 100_000;
  let tickValue: number;
  if (quote === 'USD') tickValue = valueInQuote;
  else if (BASE.has(`USD${quote}`)) tickValue = valueInQuote / BASE.get(`USD${quote}`)!;
  else tickValue = valueInQuote * (BASE.get(`${quote}USD`) ?? 1);
  return { digits, point: tickSize, tickSize, tickValue: round(tickValue, 5), volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, stopsLevel };
}

export const SAMPLE_KEYS = { a: 'sample-key-account-a', b: 'sample-key-account-b' };

// Wipes market data and accounts, then writes the sample set. Settings are reset.
export async function seedSample(db: Collections): Promise<void> {
  await Promise.all([
    db.symbols.deleteMany({}),
    db.candles.deleteMany({}),
    db.quotes.deleteMany({}),
    db.analyses.deleteMany({}),
    db.accounts.deleteMany({}),
    db.commands.deleteMany({}),
    db.news.deleteMany({}),
    db.settings.deleteMany({}),
  ]);
  await db.settings.insertOne({ _id: 'main', ...DEFAULT_SETTINGS });
  await db.symbols.insertMany(
    SAMPLE_SYMBOLS.map((s, order) => ({ _id: new ObjectId(), name: s.name, active: s.active, order, digits: defaultDigits(s.name) })),
  );
  const now = new Date();
  for (const s of SAMPLE_SYMBOLS) {
    const candles = sampleCandles(s.name, s.base, 520);
    await db.candles.insertMany(candles);
    const last = candles[candles.length - 1]!;
    const digits = defaultDigits(s.name);
    const spread = 10 ** -digits * (s.name === 'XAUUSD' ? 25 : 12);
    await db.quotes.insertOne({ _id: s.name, bid: last.c, ask: round(last.c + spread, digits), at: now });
  }

  const specs = Object.fromEntries(SAMPLE_SYMBOLS.map((s) => [s.name, sampleSpec(s.name)]));
  const account = (name: string, number: number, key: string, balance: number, extra: Partial<AccountDoc>): AccountDoc => ({
    _id: new ObjectId(),
    name,
    number,
    keyHash: sha256(key),
    riskPct: 0.1,
    aggressiveMultiplier: 2,
    aggressiveAuto: true,
    symbolMap: {},
    offsets: {},
    balance,
    currency: 'USD',
    balanceAt: now,
    specs,
    createdAt: now,
    ...extra,
  });
  await db.accounts.insertMany([
    account('Demo A', 5_100_001, SAMPLE_KEYS.a, 10_000, {}),
    // second broker: ".m" suffix, prices 0.2 pip higher, balance last synced 3 hours ago
    account('Demo B', 5_100_002, SAMPLE_KEYS.b, 5_000, {
      aggressiveMultiplier: 1.5,
      symbolMap: Object.fromEntries(SAMPLE_SYMBOLS.map((s) => [s.name, `${s.name}.m`])),
      offsets: { EURUSD: 0.00002 },
      balanceAt: new Date(now.getTime() - 3 * 3_600_000),
    }),
  ]);
}
