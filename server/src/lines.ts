// The user's own S/R lines: imported from MT4 chart templates (.tpl) or sent by the MT4
// EA from the horizontal lines on the charts. They are a reference for tuning the engine
// (lineFit); orders use them only when settings.sr.lineSource is 'manual'.
import type { SymbolInputs } from './analysis/types.ts';
import { getSettings, type Collections, type SymbolDoc } from './db.ts';
import { refreshAnalysis } from './service.ts';

// Minimum SL in pips per pair, from the user's previous order tool.
const MIN_SL_PIPS: Record<string, number> = {
  NZDUSD: 10, AUDUSD: 10, EURGBP: 10, USDCHF: 10,
  USDCAD: 15, EURUSD: 15, GBPUSD: 15, NZDJPY: 15, CADJPY: 15, AUDJPY: 15,
  CHFJPY: 20, USDJPY: 20, EURJPY: 20, GBPJPY: 20, EURNZD: 20,
  XAUUSD: 30,
};

export function defaultMinSlPips(symbol: string): number {
  return MIN_SL_PIPS[symbol.toUpperCase()] ?? 15;
}

export function symbolInputs(sym: SymbolDoc | null): SymbolInputs {
  if (!sym) return {};
  return { manualLines: sym.manualLines, minSlPips: sym.minSlPips ?? defaultMinSlPips(sym.name) };
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
