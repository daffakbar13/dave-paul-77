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
  lookback: number; // closed D1 candles used (about 2 years)
  fractal: number; // candles on each side of a swing
  atrPeriod: number;
  clusterAtr: number; // swings closer than this x ATR join one line
  minTouches: number;
  strongBodyPct: number; // body / range
  strongAtr: number; // body / ATR
  strongMaxDistanceAtr: number; // how far beyond the line a strong candle may sit
  strongPick: 'recent' | 'nearest';
  wickRatio: number; // rejection wick / range
  reboundMaxDistanceAtr: number;
  bufferAtr: number;
  autoTpRr: number; // TP = entry + autoTpRr x risk when there is no next line
  maxLinesPerSide: number; // only the N lines nearest to price get an order; 0 = all
};

export type Line = { price: number; touches: number; low: number; high: number };

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
};

export type Analysis = {
  atr: number;
  price: number; // reference price used to split lines into buy/sell
  lastCandleAt: number;
  lines: Line[];
  candidates: Candidate[];
};
