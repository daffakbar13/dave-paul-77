import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { keyAccount, requireAccountKey, requireDataKey } from '../auth.ts';
import type { Config } from '../config.ts';
import { getSettings, type Collections } from '../db.ts';
import { HttpError, notFound, parse, parseId } from '../http.ts';
import { refreshAnalysis } from '../service.ts';
import { defaultDigits } from './web.ts';

const DAY = 86_400_000;
const symbolName = z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{3,20}$/);
const price = z.number().positive().finite();

// Times from MQL are seconds in broker server time (D1 opens at broker midnight). A candle
// is only accepted once its day is over by the broker clock the EA sends as `now`.
const candleSchema = z.object({ t: z.number().int().positive(), o: price, h: price, l: price, c: price })
  .refine((c) => c.h >= Math.max(c.o, c.c, c.l) && c.l <= Math.min(c.o, c.c), 'OHLC tidak konsisten');

const candlesSchema = z.object({
  symbol: symbolName,
  digits: z.number().int().min(0).max(8).optional(),
  now: z.number().int().positive().optional(), // TimeCurrent(); without it UTC is assumed
  candles: z.array(candleSchema).min(1).max(5000),
});

const quotesSchema = z.object({
  now: z.number().int().positive().optional(),
  quotes: z.array(z.object({ symbol: symbolName, bid: price, ask: price })).min(1).max(100),
});

const specSchema = z.object({
  digits: z.number().int().min(0).max(8),
  point: price,
  tickSize: price,
  tickValue: price,
  volumeMin: price,
  volumeMax: price,
  volumeStep: price,
  stopsLevel: z.number().int().min(0),
});

const statusSchema = z.object({
  account: z.number().int().positive(),
  balance: z.number().finite(),
  currency: z.string().trim().min(3).max(5),
  // keyed by broker symbol; mapped back to app symbols with the account's symbolMap
  symbols: z.record(z.string(), specSchema).default({}),
});

const resultSchema = z.object({
  dryRun: z.boolean().default(false),
  results: z.array(z.object({
    ref: z.string().max(80),
    ok: z.boolean(),
    ticket: z.number().int().optional(),
    error: z.string().max(300).optional(),
  })).max(200),
});

export function eaRoutes(db: Collections, config: Config): Router {
  const router = Router();
  const dataKey = requireDataKey(config);
  const accountKey = requireAccountKey(db);

  // Last contact and broker clock offset (rounded to 30 minutes), shown in the web so the
  // daily check "is MT4 running" is one glance.
  async function seen(now: number | undefined) {
    const brokerOffsetMinutes = now ? Math.round((now * 1000 - Date.now()) / 1_800_000) * 30 : null;
    await db.meta.updateOne(
      { _id: 'mt4' },
      { $set: { lastSeenAt: new Date(), ...(brokerOffsetMinutes !== null ? { brokerOffsetMinutes } : {}) } },
      { upsert: true },
    );
  }

  // --- MT4 data EA -----------------------------------------------------------
  // Active pairs from the web settings, so the tab list is managed in one place.
  router.get('/mt4/symbols', dataKey, async (_req, res) => {
    const symbols = await db.symbols.find({ active: true }).sort({ order: 1 }).toArray();
    res.json({ symbols: symbols.map((s) => s.name) });
  });

  router.post('/mt4/candles', dataKey, async (req, res) => {
    const input = parse(candlesSchema, req.body);
    const now = input.now ? input.now * 1000 : Date.now();
    const closed = input.candles.filter((c) => c.t * 1000 + DAY <= now);
    if (closed.length) {
      await db.candles.bulkWrite(
        closed.map((c) => ({
          updateOne: {
            filter: { symbol: input.symbol, t: new Date(c.t * 1000) },
            update: { $set: { o: c.o, h: c.h, l: c.l, c: c.c } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    const digits = input.digits ?? defaultDigits(input.symbol);
    const exists = await db.symbols.findOne({ name: input.symbol });
    if (!exists) {
      const order = await db.symbols.countDocuments();
      await db.symbols.insertOne({ _id: new ObjectId(), name: input.symbol, active: false, order, digits });
    } else if (input.digits !== undefined && exists.digits !== input.digits) {
      await db.symbols.updateOne({ _id: exists._id }, { $set: { digits } });
    }
    if (closed.length) await refreshAnalysis(db, input.symbol, await getSettings(db));
    await seen(input.now);
    res.json({ stored: closed.length, ignoredOpen: input.candles.length - closed.length });
  });

  router.post('/mt4/quotes', dataKey, async (req, res) => {
    const { quotes, now } = parse(quotesSchema, req.body);
    const at = new Date();
    await seen(now);
    await db.quotes.bulkWrite(
      quotes.map((q) => ({ replaceOne: { filter: { _id: q.symbol }, replacement: { bid: q.bid, ask: q.ask, at }, upsert: true } })),
    );
    res.json({ stored: quotes.length });
  });

  // --- MT5 executor EA -------------------------------------------------------
  router.post('/mt5/status', accountKey, async (req, res) => {
    const account = keyAccount(res);
    const input = parse(statusSchema, req.body);
    if (input.account !== account.number) throw new HttpError(403, 'Key ini milik akun lain.');
    const byBroker = new Map(Object.entries(account.symbolMap).map(([app, broker]) => [broker, app]));
    const specs = { ...account.specs };
    for (const [broker, spec] of Object.entries(input.symbols)) specs[byBroker.get(broker) ?? broker] = spec;
    await db.accounts.updateOne(
      { _id: account._id },
      { $set: { balance: input.balance, currency: input.currency, balanceAt: new Date(), specs } },
    );
    res.json({ ok: true });
  });

  // Oldest pending, unexpired command of the logged-in account; taking it is atomic so a
  // second poll never receives the same command.
  router.get('/mt5/commands', accountKey, async (_req, res) => {
    const account = keyAccount(res);
    const now = new Date();
    await db.commands.updateMany({ accountId: account._id, status: 'pending', expiresAt: { $lt: now } }, { $set: { status: 'expired' } });
    const command = await db.commands.findOneAndUpdate(
      { accountId: account._id, status: 'pending' },
      { $set: { status: 'taken', takenAt: now } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    );
    if (!command) {
      res.json({ command: null });
      return;
    }
    res.json({ command: { id: command._id.toHexString(), createdAt: command.createdAt, orders: command.orders } });
  });

  router.post('/mt5/commands/:id/result', accountKey, async (req, res) => {
    const account = keyAccount(res);
    const id = parseId(req.params.id, 'Perintah');
    const { dryRun, results } = parse(resultSchema, req.body);
    const command = await db.commands.findOne({ _id: id, accountId: account._id });
    if (!command) throw notFound('Perintah tidak ditemukan');
    if (command.status !== 'taken') throw new HttpError(409, `Perintah berstatus ${command.status}.`);
    const status = results.every((r) => r.ok) ? 'done' : 'failed';
    await db.commands.updateOne({ _id: id }, { $set: { status, results, dryRun, finishedAt: new Date() } });
    res.json({ ok: true, status });
  });

  return router;
}
