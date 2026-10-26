import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { Router, type Request, type Response } from 'express';
import { Binary, ObjectId } from 'mongodb';
import { z } from 'zod';
import type { BacktestDoc, Collections } from '../db.ts';
import { HttpError, notFound, parse, parseId } from '../http.ts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// Saved results stay few: each holds up to ~30k trades (about 1 MB gzipped).
export const MAX_SAVED = 30;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tanggal harus YYYY-MM-DD').nullable();
const name = z.string().trim().min(1, 'Nama wajib diisi').max(80);
// a trade is a short array of numbers / strings / booleans / null (see web/src/backtestStore.ts)
const compactTrade = z.array(z.union([z.number(), z.string().max(20), z.boolean(), z.null()])).max(20);

const createSchema = z.object({
  name,
  balance: z.number().positive().finite(),
  riskPct: z.number().positive().max(100),
  from: day,
  to: day,
  excluded: z.array(z.string().max(20)).max(100),
  sr: z.record(z.string(), z.unknown()),
  warmup: z.number().int().min(0),
  maxCostR: z.number().min(0).max(10).optional(), // cost filter the run used; absent on older saves = none
  coverage: z.array(z.record(z.string(), z.unknown())).max(100),
  fingerprint: z.array(z.object({ symbol: z.string().max(20), candles: z.number().int(), first: z.number().nullable(), last: z.number().nullable() })).max(100),
  trades: z.array(compactTrade).max(200_000),
});

const renameSchema = z.object({ name });

type Meta = Omit<BacktestDoc, '_id' | 'trades'> & { id: string };

const meta = ({ _id, trades: _trades, ...d }: Omit<BacktestDoc, 'trades'> & { trades?: unknown }): Meta => ({ id: _id.toHexString(), ...d });

// JSON body, gzipped when the browser accepts it (a saved run is a few MB of JSON).
async function sendJson(req: Request, res: Response, body: string) {
  res.set({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding', 'Cache-Control': 'no-store' });
  if (/\bgzip\b/.test(req.get('accept-encoding') ?? '')) res.set('Content-Encoding', 'gzip').send(await gzipAsync(body));
  else res.send(body);
}

// Named backtest results. Mounted with its own body limit: a run's trades are a few MB.
export function backtestsRoutes(db: Collections): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const docs = await db.backtests.find({}, { projection: { trades: 0 } }).sort({ createdAt: -1 }).toArray();
    res.json({ backtests: docs.map(meta) });
  });

  router.get('/:id', async (req, res) => {
    const doc = await db.backtests.findOne({ _id: parseId(req.params.id, 'Backtest') });
    if (!doc) throw notFound('Backtest not found');
    const trades = (await gunzipAsync(doc.trades.buffer)).toString('utf8');
    // the stored trades are already JSON: spliced in, not parsed and re-serialised
    await sendJson(req, res, `${JSON.stringify(meta(doc)).slice(0, -1)},"trades":${trades}}`);
  });

  router.post('/', async (req, res) => {
    const { trades, ...b } = parse(createSchema, req.body);
    if ((await db.backtests.countDocuments()) >= MAX_SAVED) throw new HttpError(400, `Maksimal ${MAX_SAVED} hasil tersimpan; hapus yang lama dulu`);
    const zipped = await gzipAsync(JSON.stringify(trades));
    const now = new Date();
    const doc: BacktestDoc = { _id: new ObjectId(), ...b, tradeCount: trades.length, trades: new Binary(zipped), size: zipped.length, createdAt: now, updatedAt: now };
    await db.backtests.insertOne(doc);
    res.status(201).json({ backtest: meta(doc) });
  });

  router.put('/:id', async (req, res) => {
    const { name: next } = parse(renameSchema, req.body);
    const doc = await db.backtests.findOneAndUpdate(
      { _id: parseId(req.params.id, 'Backtest') },
      { $set: { name: next, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { trades: 0 } },
    );
    if (!doc) throw notFound('Backtest not found');
    res.json({ backtest: meta(doc) });
  });

  router.delete('/:id', async (req, res) => {
    const r = await db.backtests.deleteOne({ _id: parseId(req.params.id, 'Backtest') });
    if (!r.deletedCount) throw notFound('Backtest not found');
    res.status(204).end();
  });

  return router;
}
