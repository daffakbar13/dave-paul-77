// The user's own S/R lines: imported from MT4 chart templates (.tpl) or sent by the MT4
// EA from the horizontal lines on the charts. They are a reference for tuning the engine
// (lineFit); orders use them only when settings.sr.lineSource is 'manual'.
import type { SymbolInputs, Timeframe } from './analysis/types.ts';
import { getSettings, type Collections, type SymbolDoc } from './db.ts';
import { refreshAnalysis } from './service.ts';

// Minimum SL in pips per pair, from the user's previous order tool.
const MIN_SL_PIPS: Record<string, number> = {
  NZDUSD: 10, AUDUSD: 10, EURGBP: 10, USDCHF: 10,
  USDCAD: 15, EURUSD: 15, GBPUSD: 15, NZDJPY: 15, CADJPY: 15, AUDJPY: 15,
  CHFJPY: 20, USDJPY: 20, EURJPY: 20, GBPJPY: 20, EURNZD: 20,
  XAUUSD: 30,
};

// On H4 the D1 minimum is too wide: XAUUSD H4 SLs are about 21 pips, and a 30-pip floor
// took its backtest from +0.09R to +0.01R a trade, so the H4 default is no floor.
const MIN_SL_PIPS_H4: Record<string, number> = { XAUUSD: 0 };

export function defaultMinSlPips(symbol: string, tf: Timeframe = defaultTimeframe(symbol)): number {
  const s = symbol.toUpperCase();
  if (tf === 'H4' && MIN_SL_PIPS_H4[s] !== undefined) return MIN_SL_PIPS_H4[s];
  return MIN_SL_PIPS[s] ?? 15;
}

// Pairs analysed on H4 unless the user picks otherwise in Settings > Pairs.
const H4_PAIRS = new Set(['XAUUSD']);

export function defaultTimeframe(symbol: string): Timeframe {
  return H4_PAIRS.has(symbol.toUpperCase()) ? 'H4' : 'D1';
}

export function timeframeOf(sym: Pick<SymbolDoc, 'name' | 'timeframe'> | null, name = sym?.name ?? ''): Timeframe {
  return sym?.timeframe ?? defaultTimeframe(name);
}

// The minimum SL in pips the pair uses now: its own value, else the default of its timeframe.
export function minSlPipsOf(sym: Pick<SymbolDoc, 'name' | 'timeframe' | 'minSlPips'>): number {
  return sym.minSlPips ?? defaultMinSlPips(sym.name, timeframeOf(sym));
}

export function symbolInputs(sym: SymbolDoc | null): SymbolInputs {
  if (!sym) return {};
  return { manualLines: sym.manualLines, minSlPips: minSlPipsOf(sym) };
}

export type TplLines = { symbol: string; period: number; lines: number[] };

// MT4/MT5 chart template: `symbol=`, `period=` and <object> blocks; type=1 is a
// horizontal line with its price in value_0.
export function parseTpl(content: string): TplLines | null {
  const text = content.replace(/\r/g, '');
  const symbol = /^symbol=(\S+)/m.exec(text)?.[1];
  if (!symbol) return null;
  const period = Number(/^period=(\d+)/m.exec(text)?.[1] ?? 0);
  const lines: number[] = [];
  for (const block of text.match(/<object>[\s\S]*?<\/object>/g) ?? []) {
    if (!/^type=1$/m.test(block)) continue;
    const value = Number(/^value_0=([\d.]+)/m.exec(block)?.[1]);
    if (Number.isFinite(value) && value > 0) lines.push(value);
  }
  return { symbol: symbol.toUpperCase(), period, lines: [...new Set(lines)].sort((a, b) => a - b) };
}

// Saves the lines (an empty list removes them) and recomputes the symbol.
export async function setManualLines(db: Collections, symbol: string, lines: number[], source: 'import' | 'mt4' | 'web'): Promise<void> {
  const clean = [...new Set(lines.filter((x) => Number.isFinite(x) && x > 0))].sort((a, b) => a - b);
  await db.symbols.updateOne(
    { name: symbol },
    clean.length
      ? { $set: { manualLines: clean, manualLinesAt: new Date(), manualLinesSource: source } }
      : { $unset: { manualLines: '', manualLinesAt: '', manualLinesSource: '' } },
  );
  await refreshAnalysis(db, symbol, await getSettings(db));
}
