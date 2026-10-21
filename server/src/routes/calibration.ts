import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { compareAll, sweep, type ManualOrder, type SymbolData } from '../analysis/calibrate.ts';
import { getSettings, type Collections, type ManualOrderDoc } from '../db.ts';
import { notFound, parse, parseId } from '../http.ts';
import { defaultDigits } from './web.ts';

const price = z.number().positive().finite();

const orderSchema = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{3,20}$/, 'Nama simbol tidak valid'),
  side: z.enum(['buy', 'sell']),
  entry: price,
  sl: price,
  tp: price.nullable().default(null),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tanggal harus YYYY-MM-DD'),
  note: z.string().trim().max(200).default(''),
}).refine((o) => (o.side === 'buy' ? o.sl < o.entry : o.sl > o.entry), { message: 'SL harus di sisi rugi entry', path: ['sl'] })
  .refine((o) => o.tp === null || (o.side === 'buy' ? o.tp > o.entry : o.tp < o.entry), { message: 'TP harus di sisi untung entry', path: ['tp'] });

const toManual = (d: ManualOrderDoc): ManualOrder => ({
  id: d._id.toHexString(),
  symbol: d.symbol,
  side: d.side,
  entry: d.entry,
  sl: d.sl,
  tp: d.tp,
  asOf: d.asOf.getTime(),
});

// All stored candles of the symbols that have manual orders (the engine slices per day).
async function loadData(db: Collections, symbols: string[]): Promise<Map<string, SymbolData>> {
  const map = new Map<string, SymbolData>();
  for (const symbol of new Set(symbols)) {
    const docs = await db.candles.find({ symbol }).sort({ t: 1 }).toArray();
    if (!docs.length) continue;
    const sym = await db.symbols.findOne({ name: symbol });
    map.set(symbol, {
      digits: sym?.digits ?? defaultDigits(symbol),
      candles: docs.map((c) => ({ t: c.t.getTime(), o: c.o, h: c.h, l: c.l, c: c.c })),
    });
  }
  return map;
}

export function calibrationRoutes(db: Collections): Router {
  const router = Router();

  async function load() {
    const docs = await db.manualOrders.find().sort({ asOf: -1, symbol: 1 }).toArray();
    const orders = docs.map(toManual);
    return { docs, orders, data: await loadData(db, orders.map((o) => o.symbol)) };
  }

  router.get('/', async (_req, res) => {
    const settings = await getSettings(db);
    const { docs, orders, data } = await load();
    const { rows, score } = compareAll(orders, data, settings.sr);
    res.json({
      orders: docs.map((d, i) => ({ ...toManual(d), note: d.note, digits: data.get(d.symbol)?.digits ?? defaultDigits(d.symbol), comparison: rows[i] })),
      score,
      sr: settings.sr,
    });
  });

  router.post('/orders', async (req, res) => {
    const input = parse(orderSchema, req.body);
    const doc: ManualOrderDoc = {
      _id: new ObjectId(),
      ...input,
      asOf: new Date(`${input.asOf}T00:00:00Z`),
      createdAt: new Date(),
    };
    await db.manualOrders.insertOne(doc);
    res.status(201).json({ id: doc._id.toHexString() });
  });

  router.delete('/orders/:id', async (req, res) => {
    const result = await db.manualOrders.deleteOne({ _id: parseId(req.params.id, 'Order manual') });
    if (!result.deletedCount) throw notFound('Order manual tidak ditemukan');
    res.status(204).end();
  });

  // Grid search over the S/R parameters (about a thousand combinations); the client
  // applies a result through PUT /settings.
  router.post('/sweep', async (_req, res) => {
    const settings = await getSettings(db);
    const { orders, data } = await load();
    if (!orders.length) {
      res.json({ current: { matched: 0, total: 0, error: 0 }, best: [], tried: 0 });
      return;
    }
    res.json(sweep(orders, data, settings.sr));
  });

  return router;
}
