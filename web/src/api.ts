// Thin client for the Render backend. Shapes mirror server/src (routes/web.ts, analysis/orders.ts).
import type { CompactTrade, Fingerprint } from './backtestStore.ts';
import type { CostSettings, Coverage } from './engine/backtest.ts';

export type Side = 'buy' | 'sell';
export type AggressiveMode = 'auto' | 'on' | 'off';
export type RowStatus = 'valid' | 'skipped' | 'invalid' | 'cancelled' | 'running';

export type OrderRow = {
  id: string;
  symbol: string;
  side: Side;
  type: 'buy stop' | 'sell stop';
  line: number;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  tpAuto: boolean;
  slFrom?: 'candle' | 'ladder';
  lot: number | null;
  risk: number | null;
  rr: number | null;
  lowRr: boolean;
  multiplier: number;
  status: RowStatus;
  reason?: string;
  position?: number; // ticket of the open position this level came from
};

export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type Line = { price: number; touches: number; ranges?: number; strength?: number; low: number; high: number; source?: 'manual' | 'auto' };

export type AccountInfo = {
  id: string;
  name: string;
  number: number;
  balance: number | null;
  currency: string | null;
  balanceAt: string | null;
  stale: boolean;
  multiplier: number; // the account's Aggressive multiplier
  aggressiveAuto: boolean;
};

export type Analysis = {
  symbol: string;
  digits: number;
  analyzedAt: string;
  lastCandleAt: string;
  atr: number;
  price: number;
  quote: { bid: number; ask: number; at: string } | null;
  candles: Candle[];
  lines: Line[];
  referenceLines: number[];
  rows: OrderRow[];
  account: AccountInfo | null;
  newsAffected: boolean;
};

export type RiskSummary = { orders: number; running: number; totalRisk: number; lowRr: number; byCurrency: Record<string, number> };
export type AccountOrders = { account: AccountInfo; rows: OrderRow[]; summary: RiskSummary };

export type SymbolItem = {
  name: string;
  active: boolean;
  order: number;
  digits: number;
  candidates: number;
  lastCandleAt: string | null;
  manualLines: number; // the user's reference lines; 0 = none
  manualLinesAt: string | null;
  manualLinesSource: 'import' | 'mt4' | 'web' | null;
  minSlPips: number;
};
export type Colors = { sr: string; entry: string; sltp: string };

export type Account = {
  id: string;
  name: string;
  number: number;
  riskPct: number;
  aggressiveMultiplier: number;
  aggressiveAuto: boolean;
  symbolMap: Record<string, string>;
  offsets: Record<string, number>;
  balance: number | null;
  currency: string | null;
  balanceAt: string | null;
  specSymbols: string[];
};

export type LineFit = { symbol: string; atr: number; engine: number; reference: number; matched: number; precision: number; recall: number; f1: number };
export type LineScore = { pairs: number; f1: number; precision: number; recall: number };

export type SrParams = {
  lineSource: 'auto' | 'manual';
  lookback: number;
  fractal: number;
  atrPeriod: number;
  clusterAtr: number;
  minTouches: number;
  rangeMinBars: number;
  rangeMaxAtr: number;
  rangeWeight: number;
  minSpacingAtr: number;
  zoneMergeAtr: number;
  strongBodyPct: number;
  strongAtr: number;
  strongMaxDistanceAtr: number;
  strongPick: 'recent' | 'nearest';
  wickRatio: number;
  reboundMaxDistanceAtr: number;
  bufferAtr: number;
  autoTpRr: number;
  maxLinesPerSide: number;
  orderModel: 'ladder' | 'strong';
  entryGap: number;
  slGap: number;
  tpGap: number;
  minDistanceAtr: number;
  slSource: 'candle' | 'ladder';
  slStrongAtr: number;
  slMaxRiskAtr: number;
};

export type Settings = {
  version: number;
  rrThreshold: number;
  newsWindowHours: number;
  commandTtlHours: number;
  balanceStaleMinutes: number;
  quoteMaxAgeMinutes: number;
  sr: SrParams;
  colors: Colors;
  costs: CostSettings; // backtest only
};

export type Command = {
  id: string;
  accountId: string;
  accountNumber: number;
  status: 'pending' | 'taken' | 'done' | 'failed' | 'expired' | 'superseded';
  orders: { ref: string; symbol: string; side: Side; entry: number; sl: number; tp: number; lot: number }[];
  createdAt: string;
  expiresAt: string;
  results?: { ref: string; ok: boolean; ticket?: number; error?: string }[];
  dryRun?: boolean;
  deleted?: number; // app pending orders removed by the EA (or that would be, in dry-run)
};

export type CloseReason = 'sl' | 'tp' | 'so' | 'expert' | 'manual';

export type TradePlan = {
  commandId: string;
  placedAt: string;
  aggressive: AggressiveMode;
  line: number;
  lineSource: 'manual' | 'auto';
  entry: number;
  sl: number;
  tp: number;
  tpAuto: boolean;
  slFrom?: 'candle' | 'ladder';
  lot: number;
  risk: number | null;
  rr: number | null;
  multiplier: number;
  atr: number | null;
  newsAffected: boolean;
};

export type JournalTrade = {
  id: string;
  accountNumber: number;
  ticket: number;
  ref: string | null;
  symbol: string;
  side: Side;
  status: 'placed' | 'cancelled' | 'open' | 'closed';
  plan: TradePlan | null;
  deals: number;
  openedAt: string | null;
  openPrice: number | null;
  volume: number;
  closedAt: string | null;
  closePrice: number | null;
  closeReason: CloseReason | null;
  profit: number;
  costs: number;
  net: number;
  r: number | null;
};

export type AuditStats = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  net: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgR: number | null;
  totalR: number | null;
};
export type AuditGroup = AuditStats & { key: string };
export type Finding = { level: 'warn' | 'info' | 'good'; text: string };

export type Audit = {
  stats: AuditStats;
  maxDrawdown: number;
  avgHoldHours: number | null;
  avgSlipR: number | null;
  bySymbol: AuditGroup[];
  bySide: AuditGroup[];
  byReason: AuditGroup[];
  bySlFrom: AuditGroup[];
  byMode: AuditGroup[];
  byLineSource: AuditGroup[];
  byRr: AuditGroup[];
  fills: { placed: number; filled: number; cancelled: number; rate: number | null };
  unplanned: number;
  findings: Finding[];
};

export type Journal = { currency: string | null; audit: Audit; trades: JournalTrade[]; open: JournalTrade[] };

export type Mt4Status = { lastSeenAt: string; brokerOffsetMinutes?: number } | null;

export type CalibrationScore = { matched: number; total: number; error: number };

export type ManualOrder = {
  id: string;
  symbol: string;
  side: Side;
  entry: number;
  sl: number;
  tp: number | null;
  asOf: number;
  note: string;
  digits: number;
  comparison: {
    atr: number;
    auto: { line: number; entry?: number; sl?: number; tp?: number; tpAuto?: boolean } | null;
    nearestLine: number | null;
    dEntry: number | null;
    dSl: number | null;
    dTp: number | null;
    match: boolean;
    reason?: string;
  };
};

export type SweepResult = { current: CalibrationScore; best: { params: Partial<SrParams>; score: CalibrationScore }[]; tried: number };

// A named backtest result kept on the server (trades only in the single GET).
export type SavedBacktest = {
  id: string;
  name: string;
  balance: number;
  riskPct: number;
  from: string | null;
  to: string | null;
  excluded: string[];
  sr: SrParams;
  warmup: number;
  maxCostR?: number;
  coverage: Coverage[];
  fingerprint: Fingerprint[];
  tradeCount: number;
  size: number;
  createdAt: string;
  updatedAt: string;
};

export type News = { id: string; at: string; currency: string; impact: string; title: string };
export type NewsFeed = {
  news: News[];
  affected: string[]; // currencies with red news ahead in the window
  windowHours: number;
  status: { source: string | null; fetchedAt: string | null; error: string | null; retryAt: string | null };
};

const BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const TOKEN_KEY = 'dp77-token';

let token: string | null = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}

export const hasToken = () => !!token;

export function setToken(value: string | null) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked: the session lasts until reload
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Fired on 401 so the app returns to the login screen.
export const UNAUTHORIZED = 'dp77-unauthorized';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') {
      setToken(null);
      window.dispatchEvent(new Event(UNAUTHORIZED));
    }
    throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

const q = (params: Record<string, string | boolean | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v === true ? 1 : v === false ? 0 : v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  login: (password: string) => request<{ token: string; expiresAt: string }>('POST', '/auth/login', { password }),
  symbols: () => request<{ symbols: SymbolItem[]; colors: Colors; mt4: Mt4Status }>('GET', '/symbols'),
  saveSymbols: (list: { name: string; active: boolean; minSlPips?: number }[]) => request<{ ok: true }>('PUT', '/symbols', list),
  setLines: (symbol: string, lines: number[]) => request<{ symbol: string; lines: number }>('PUT', `/symbols/${encodeURIComponent(symbol)}/lines`, { lines }),
  importTpl: (files: { name: string; content: string }[]) =>
    request<{ results: { file: string; symbol?: string; lines?: number; error?: string }[] }>('POST', '/lines/import-tpl', { files }),
  analysis: (symbol: string, accountId?: string, aggressive?: AggressiveMode) =>
    request<Analysis>('GET', `/analysis/${encodeURIComponent(symbol)}${q({ accountId, aggressive })}`),
  cancel: (id: string) => request<{ ok: true }>('POST', `/orders/${encodeURIComponent(id)}/cancel`),
  restore: (id: string) => request<{ ok: true }>('POST', `/orders/${encodeURIComponent(id)}/restore`),
  // undo every X: one pair, or all pairs without a symbol
  restoreAll: (symbol?: string) => request<{ restored: number }>('POST', '/orders/restore-all', symbol ? { symbol } : {}),
  orders: (accountId: string, aggressive: AggressiveMode) => request<AccountOrders>('GET', `/orders${q({ accountId, aggressive })}`),
  preview: (accountIds: string[], aggressive: AggressiveMode) =>
    request<{ accounts: AccountOrders[] }>('POST', '/execute/preview', { accountIds, aggressive }),
  execute: (accountIds: string[], aggressive: AggressiveMode) =>
    request<{ commands: Command[] }>('POST', '/execute', { accountIds, aggressive }),
  commands: () => request<{ commands: Command[] }>('GET', '/commands'),
  journal: (accountId: string, from: string, to: string) => request<Journal>('GET', `/journal${q({ accountId, from, to })}`),
  // stored D1 candles (compact arrays) and the saved S/R settings, for the in-browser backtest
  backtestCandles: (symbols?: string[]) =>
    request<{ sr: SrParams; symbols: { name: string; digits: number; inputs: { manualLines?: number[]; minSlPips?: number }; candles: number[][] }[] }>(
      'GET',
      `/backtest/candles${q({ symbols: symbols?.join(',') })}`,
    ),
  savedBacktests: () => request<{ backtests: SavedBacktest[] }>('GET', '/backtests'),
  savedBacktest: (id: string) => request<SavedBacktest & { trades: CompactTrade[] }>('GET', `/backtests/${id}`),
  saveBacktest: (b: Omit<SavedBacktest, 'id' | 'tradeCount' | 'size' | 'createdAt' | 'updatedAt'> & { trades: CompactTrade[] }) =>
    request<{ backtest: SavedBacktest }>('POST', '/backtests', b),
  renameBacktest: (id: string, name: string) => request<{ backtest: SavedBacktest }>('PUT', `/backtests/${id}`, { name }),
  deleteBacktest: (id: string) => request<void>('DELETE', `/backtests/${id}`),
  news: () => request<NewsFeed>('GET', '/news'),
  refreshNews: () => request<NewsFeed>('POST', '/news/refresh'),
  upcomingNews: () => request<{ news: News[]; status: NewsFeed['status'] }>('GET', '/news/upcoming'),
  settings: () => request<Settings>('GET', '/settings'),
  saveSettings: (patch: Partial<Omit<Settings, 'version'>>) => request<Settings>('PUT', '/settings', patch),
  accounts: () => request<{ accounts: Account[] }>('GET', '/accounts'),
  createAccount: (a: Partial<Account>) => request<{ account: Account; key: string }>('POST', '/accounts', a),
  updateAccount: (id: string, a: Partial<Account>) => request<{ account: Account }>('PUT', `/accounts/${id}`, a),
  deleteAccount: (id: string) => request<void>('DELETE', `/accounts/${id}`),
  calibration: () => request<{ orders: ManualOrder[]; score: CalibrationScore; sr: SrParams }>('GET', '/calibration'),
  addManual: (o: { symbol: string; side: Side; entry: number; sl: number; tp: number | null; asOf: string; note: string }) =>
    request<{ id: string }>('POST', '/calibration/orders', o),
  deleteManual: (id: string) => request<void>('DELETE', `/calibration/orders/${id}`),
  sweep: () => request<SweepResult>('POST', '/calibration/sweep'),
  lineFit: () => request<{ fits: LineFit[]; score: LineScore; sr: SrParams }>('GET', '/calibration/lines'),
  lineSweep: () => request<{ current: LineScore; best: { params: Partial<SrParams>; score: LineScore }[]; tried: number }>('POST', '/calibration/lines/sweep'),
  rotateKey: (id: string) => request<{ key: string }>('POST', `/accounts/${id}/key`),
};
