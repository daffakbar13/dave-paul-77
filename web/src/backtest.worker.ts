// Runs the backtest off the page's main thread. The candles come from the server
// (GET /api/backtest/candles); nothing is sent back to it.
import { runBacktest, type BacktestRun } from './engine/backtest.ts';
import type { SrParams, SymbolData, SymbolInputs } from './engine/types.ts';

export type WorkerSymbol = { name: string; digits: number; inputs: SymbolInputs; candles: number[][] };
export type WorkerIn = { symbols: WorkerSymbol[]; sr: SrParams; balance: number; riskPct: number; from?: number; to?: number; warmup?: number };
export type WorkerOut = { type: 'progress'; done: number; total: number } | { type: 'done'; run: BacktestRun } | { type: 'error'; message: string };

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  const post = (out: WorkerOut) => self.postMessage(out);
  try {
    const data = new Map<string, SymbolData>(
      m.symbols.map((s) => [
        s.name,
        { digits: s.digits, inputs: s.inputs, candles: s.candles.map(([t, o, h, l, c]) => ({ t: t!, o: o!, h: h!, l: l!, c: c! })) },
      ]),
    );
    const run = await runBacktest({
      data,
      params: m.sr,
      balance: m.balance,
      riskPct: m.riskPct,
      ...(m.from !== undefined ? { from: m.from } : {}),
      ...(m.to !== undefined ? { to: m.to } : {}),
      ...(m.warmup !== undefined ? { warmup: m.warmup } : {}),
      pause: async () => {}, // own thread: no need to yield
      onProgress: (done, total) => post({ type: 'progress', done, total }),
    });
    post({ type: 'done', run });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
