import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { runBacktest, type Coverage } from '../analysis/backtest.ts';
import { equityCurve, monthTable, overall, pairStats, thin, tradesCsv, type BtTrade } from '../analysis/backtestStats.ts';
import type { SrParams } from '../analysis/types.ts';
import { getSettings, type Collections } from '../db.ts';
import { HttpError, notFound, parse } from '../http.ts';
import { loadData } from './calibration.ts';

const symbolName = z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{3,20}$/, 'Nama simbol tidak valid');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tanggal harus YYYY-MM-DD');

const runSchema = z.object({
  balance: z.number().positive().max(1e9),
  riskPct: z.number().positive().max(20),
  symbols: z.array(symbolName).max(60).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  warmup: z.number().int().min(20).max(2000).optional(),
});

type Job = {
  id: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  progress: { done: number; total: number };
  error?: string;
  input: { balance: number; riskPct: number; symbols: string[]; from: string | null; to: string | null };
  sr?: SrParams;
  warmup?: number;
  coverage?: Coverage[];
  trades?: BtTrade[];
};

// Results live in memory: the trade list of a 20-year run is too big for one document and
// is cheap to run again. Only the latest few are kept.
const KEEP = 4;
const TTL = 6 * 3_600_000;
const CURVE_POINTS = 600;

export function backtestRoutes(db: Collections): Router {
  const router = Router();
  const jobs = new Map<string, Job>();

  const prune = () => {
    const now = Date.now();
    for (const [id, j] of jobs) if (now - j.startedAt > TTL) jobs.delete(id);
    while (jobs.size > KEEP) jobs.delete(jobs.keys().next().value!);
  };

  const find = (id: string): Job => {
    const job = jobs.get(id);
    if (!job) throw notFound('Backtest tidak ditemukan atau sudah kedaluwarsa; jalankan lagi');
    return job;
  };

  const filter = (job: Job, symbol: unknown): { trades: BtTrade[]; symbol: string | null } => {
    const trades = job.trades ?? [];
    if (typeof symbol !== 'string' || !symbol || symbol === 'ALL') return { trades, symbol: null };
    const s = symbol.toUpperCase();
    return { trades: trades.filter((t) => t.symbol === s), symbol: s };
  };

  router.post('/run', async (req, res) => {
    const input = parse(runSchema, req.body);
    const active = (await db.symbols.find({ active: true }).sort({ order: 1 }).toArray()).map((s) => s.name);
    const symbols = input.symbols?.length ? input.symbols : active;
    if (!symbols.length) throw new HttpError(400, 'Belum ada pair aktif');
    const from = input.from ? Date.parse(`${input.from}T00:00:00Z`) : undefined;
    const to = input.to ? Date.parse(`${input.to}T00:00:00Z`) : undefined;
    if (from !== undefined && to !== undefined && from > to) throw new HttpError(400, 'Tanggal awal setelah tanggal akhir');

    const settings = await getSettings(db);
    const job: Job = {
      id: randomUUID(),
      status: 'running',
      startedAt: Date.now(),
      progress: { done: 0, total: symbols.length },
      input: { balance: input.balance, riskPct: input.riskPct, symbols, from: input.from ?? null, to: input.to ?? null },
      sr: settings.sr,
    };
    jobs.set(job.id, job);
    prune();
    res.status(202).json({ id: job.id });

    void (async () => {
      try {
        const data = await loadData(db, symbols);
        job.progress.total = data.size;
        if (!data.size) throw new Error('Belum ada data candle untuk pair ini');
        const run = await runBacktest({
          data,
          params: settings.sr,
          balance: input.balance,
          riskPct: input.riskPct,
          ...(input.warmup !== undefined ? { warmup: input.warmup } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          onProgress: (done, total) => {
            job.progress = { done, total };
          },
        });
        job.trades = run.trades;
        job.coverage = run.coverage;
        job.warmup = run.warmup;
        job.status = 'done';
      } catch (e) {
        job.status = 'error';
        job.error = (e as Error).message;
      }
    })();
  });

  // Status while running; the three summary screens plus the per-pair table when done.
  // ?symbol=EURUSD narrows the screens to one pair (money is that pair's share of the run).
  router.get('/:id', (req, res) => {
    const job = find(String(req.params.id));
    const head = { id: job.id, status: job.status, progress: job.progress, input: job.input, error: job.error ?? null };
    if (job.status !== 'done' || !job.trades) {
      res.json(head);
      return;
    }
    const { trades, symbol } = filter(job, req.query.symbol);
    const initial = job.input.balance;
    const byPair = new Map<string, BtTrade[]>();
    for (const t of job.trades) byPair.set(t.symbol, [...(byPair.get(t.symbol) ?? []), t]);
    res.json({
      ...head,
      symbol,
      warmup: job.warmup,
      sr: job.sr,
      coverage: job.coverage,
      overall: overall(trades, initial),
      monthsPips: monthTable(trades, (t) => t.pips),
      monthsMoney: monthTable(trades, (t) => t.profit),
      curve: thin(equityCurve(trades, initial), CURVE_POINTS),
      pairs: (job.coverage ?? []).map((c) => ({ ...pairStats(c.symbol, byPair.get(c.symbol) ?? [], initial), tier: c.tier, years: c.years })),
    });
  });

  router.get('/:id/csv', (req, res) => {
    const job = find(String(req.params.id));
    if (job.status !== 'done') throw new HttpError(409, 'Backtest belum selesai');
    const { trades, symbol } = filter(job, req.query.symbol);
    const detail = req.query.detail === '1';
    res
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="backtest-${symbol ?? 'semua-pair'}${detail ? '-detail' : ''}.csv"`,
      })
      .send(tradesCsv(trades, detail));
  });

  return router;
}
