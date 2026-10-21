import { MongoClient, type Collection, type Db, type ObjectId } from 'mongodb';
import { DEFAULT_SR } from './analysis/sr.ts';
import type { Candidate, Line, Side, SrParams, SymbolSpec } from './analysis/types.ts';

// One document, _id 'main'. `version` changes on every save so stored analyses know
// they were computed with old parameters.
export type Settings = {
  _id: 'main';
  version: number;
  rrThreshold: number; // rows below this RR get the light-yellow marker
  newsWindowHours: number;
  commandTtlHours: number;
  balanceStaleMinutes: number;
  quoteMaxAgeMinutes: number;
  sr: SrParams;
  colors: { sr: string; entry: string; sltp: string };
};

export const DEFAULT_SETTINGS: Omit<Settings, '_id'> = {
  version: 1,
  rrThreshold: 1.5,
  newsWindowHours: 24,
  commandTtlHours: 24,
  balanceStaleMinutes: 60,
  quoteMaxAgeMinutes: 30,
  sr: DEFAULT_SR,
  colors: { sr: '#FFD60A', entry: '#FFFFFF', sltp: '#FF453A' },
};

export type SymbolDoc = {
  _id: ObjectId;
  name: string;
  active: boolean;
  order: number;
  digits: number;
  manualLines?: number[]; // the user's own S/R lines; absent = automatic lines
  manualLinesAt?: Date;
  manualLinesSource?: 'import' | 'mt4' | 'web';
  minSlPips?: number; // absent = default per pair (lines.ts)
};

export type CandleDoc = { _id?: ObjectId; symbol: string; t: Date; o: number; h: number; l: number; c: number };

export type QuoteDoc = { _id: string; bid: number; ask: number; at: Date }; // _id = symbol

export type AnalysisDoc = {
  _id: string; // symbol
  analyzedAt: Date;
  settingsVersion: number;
  lastCandleAt: Date;
  atr: number;
  price: number;
  lines: Line[];
  candidates: Candidate[];
  cancelled: string[]; // candidate ids; kept while the last candle is the same
};

export type AccountDoc = {
  _id: ObjectId;
  name: string;
  number: number; // MT5 login, unique
  keyHash: string; // sha256 of the EA key; the key itself is shown once
  riskPct: number;
  aggressiveMultiplier: number;
  aggressiveAuto: boolean;
  symbolMap: Record<string, string>; // app symbol -> broker symbol (suffix)
  offsets: Record<string, number>; // app symbol -> MT5 minus MT4 price
  balance: number | null;
  currency: string | null;
  balanceAt: Date | null;
  specs: Record<string, SymbolSpec>; // by app symbol
  createdAt: Date;
};

export type CommandOrder = {
  ref: string; // candidate id
  symbol: string; // broker symbol
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  lot: number;
};

export type CommandStatus = 'pending' | 'taken' | 'done' | 'failed' | 'expired' | 'superseded';

export type CommandDoc = {
  _id: ObjectId;
  accountId: ObjectId;
  accountNumber: number;
  orders: CommandOrder[];
  aggressive: 'auto' | 'on' | 'off';
  status: CommandStatus;
  createdAt: Date;
  expiresAt: Date;
  takenAt?: Date;
  finishedAt?: Date;
  dryRun?: boolean;
  deleted?: number;
  results?: { ref: string; ok: boolean; ticket?: number; error?: string }[];
  purgeAt: Date; // TTL
};

export type NewsDoc = { _id: ObjectId; at: Date; currency: string; impact: 'high' | 'medium' | 'low'; title: string };

// Small status documents: 'mt4' (last contact, broker clock) and 'news' (calendar fetch).
export type MetaDoc = {
  _id: 'mt4' | 'news';
  lastSeenAt?: Date;
  brokerOffsetMinutes?: number;
  source?: string;
  fetchedAt?: Date;
  error?: string | null;
};

// Manual orders the user placed by hand, used to calibrate the S/R parameters.
export type ManualOrderDoc = {
  _id: ObjectId;
  symbol: string;
  side: Side;
  entry: number;
  sl: number;
  tp: number | null;
  asOf: Date; // trading day the order was placed (candles before it are used)
  note: string;
  createdAt: Date;
};

export type Collections = {
  settings: Collection<Settings>;
  symbols: Collection<SymbolDoc>;
  candles: Collection<CandleDoc>;
  quotes: Collection<QuoteDoc>;
  analyses: Collection<AnalysisDoc>;
  accounts: Collection<AccountDoc>;
  commands: Collection<CommandDoc>;
  news: Collection<NewsDoc>;
  meta: Collection<MetaDoc>;
  manualOrders: Collection<ManualOrderDoc>;
};

export function collections(db: Db): Collections {
  return {
    settings: db.collection<Settings>('settings'),
    symbols: db.collection<SymbolDoc>('symbols'),
    candles: db.collection<CandleDoc>('candles'),
    quotes: db.collection<QuoteDoc>('quotes'),
    analyses: db.collection<AnalysisDoc>('analyses'),
    accounts: db.collection<AccountDoc>('accounts'),
    commands: db.collection<CommandDoc>('commands'),
    news: db.collection<NewsDoc>('news'),
    meta: db.collection<MetaDoc>('meta'),
    manualOrders: db.collection<ManualOrderDoc>('manual_orders'),
  };
}

export async function ensureIndexes(c: Collections): Promise<void> {
  await c.symbols.createIndex({ name: 1 }, { unique: true });
  await c.candles.createIndex({ symbol: 1, t: 1 }, { unique: true });
  await c.accounts.createIndex({ number: 1 }, { unique: true });
  await c.accounts.createIndex({ keyHash: 1 }, { unique: true });
  await c.commands.createIndex({ accountId: 1, status: 1 });
  await c.commands.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  await c.news.createIndex({ at: 1 });
  await c.manualOrders.createIndex({ symbol: 1, asOf: 1 });
}

export async function getSettings(c: Collections): Promise<Settings> {
  const found = await c.settings.findOne({ _id: 'main' });
  if (found) return { ...DEFAULT_SETTINGS, ...found, sr: { ...DEFAULT_SR, ...found.sr } };
  const fresh: Settings = { _id: 'main', ...DEFAULT_SETTINGS };
  await c.settings.updateOne({ _id: 'main' }, { $setOnInsert: fresh }, { upsert: true });
  return fresh;
}

export async function connect(uri: string, dbName: string): Promise<{ client: MongoClient; db: Collections }> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = collections(client.db(dbName));
  await ensureIndexes(db);
  return { client, db };
}
