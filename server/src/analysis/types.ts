// Shared shapes for the D1 support/resistance engine. Prices are plain numbers in the
// symbol's quote currency; times are milliseconds since epoch (UTC, candle open time).

export type Candle = { t: number; o: number; h: number; l: number; c: number };

export type Side = 'buy' | 'sell';

// Symbol specification as reported by the MT5 EA (SymbolInfo*). tickValue is the
// account-currency value of one tickSize move for 1.0 lot, so it already handles
// JPY pairs, crosses and XAUUSD.
export type SymbolSpec = {
  digits: number;
  point: number;
  tickSize: number;
  tickValue: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  stopsLevel: number; // in points
};

// Every value has a default in settings and can be changed from the web.
export type SrParams = {
  // 'auto' (default): the engine draws the lines; the user's lines are only a reference
  // to compare against. 'manual': the user's lines replace the engine's where present.
  lineSource: 'auto' | 'manual';
  lookback: number; // closed D1 candles used (about 2 years)
  fractal: number; // candles on each side of a swing
  atrPeriod: number;
  clusterAtr: number; // swings closer than this x ATR join one line
  minTouches: number; // line weight needed: each swing counts 1, each range edge rangeWeight
  rangeMinBars: number; // a sideways area lasts at least this many candles
  rangeMaxAtr: number; // ... with highs and lows within this x ATR
  rangeWeight: number; // weight of one range edge against one swing
  minSpacingAtr: number; // two lines closer than this x ATR merge into their average; 0 = off
  zoneMergeAtr: number; // ... also when their nearest swings are within this x ATR and price never traded between them; 0 = off
  strongBodyPct: number; // body / range
  strongAtr: number; // body / ATR
  strongMaxDistanceAtr: number; // how far beyond the line a strong candle may sit
  strongPick: 'recent' | 'nearest';
  wickRatio: number; // rejection wick / range
  reboundMaxDistanceAtr: number;
  bufferAtr: number;
  autoTpRr: number; // TP = entry + autoTpRr x risk when there is no next line
  maxLinesPerSide: number; // only the N lines nearest to price get an order; 0 = all
  // 'ladder' (default, fitted to the user's own orders): entry, SL and TP are set from
  // the distance g between a line and the next line in the trade direction.
  // 'strong': entry beyond the nearest strong candle, SL at the nearest rebound.
  orderModel: 'ladder' | 'strong';
  entryGap: number; // entry = line + entryGap x g
  slGap: number; // SL = line - slGap x g (other side of the same line)
  tpGap: number; // TP = next line - tpGap x g
  minDistanceAtr: number; // orders whose entry is closer than this to price are skipped
  // ladder SL source: 'candle' = beyond the nearest strong D1 candle on the SL side of the
  // line (low - buffer for buy, high + buffer for sell), falling back to the ladder SL;
  // 'ladder' = always line - slGap x g
  slSource: 'candle' | 'ladder';
  slStrongAtr: number; // candle SL: minimum body in ATR (shape test uses strongBodyPct)
  slMaxRiskAtr: number; // candle SL: wider than this from entry falls back to the ladder SL
};

// Per-symbol inputs that are not candles.
export type SymbolInputs = {
  manualLines?: number[]; // the user's own S/R lines: a reference, used for orders only with lineSource 'manual'
  minSlPips?: number; // SL is widened to at least this many pips
};

// touches = swings in the line, ranges = range edges in it, strength = their total weight
export type Line = { price: number; touches: number; ranges?: number; strength?: number; low: number; high: number; source?: 'manual' | 'auto' };

export type Candidate = {
  id: string; // `${symbol}:${side}-${line}`; stable for the same line
  side: Side;
  line: number;
  entry?: number;
  sl?: number;
  tp?: number;
  tpAuto?: boolean;
  strongAt?: number; // candle time used for entry
  reboundAt?: number; // candle time used for SL
  skipped?: string; // reason the line has no order
  slFrom?: 'candle' | 'ladder'; // ladder model: where the SL came from
};

export type Analysis = {
  atr: number;
  price: number; // reference price used to split lines into buy/sell
  lastCandleAt: number;
  lines: Line[];
  candidates: Candidate[];
};

// One pair's history for the engine and the backtest.
export type SymbolData = { candles: Candle[]; digits: number; inputs?: SymbolInputs };
