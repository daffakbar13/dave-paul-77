import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { newAccountKey } from '../auth.ts';
import { getSettings, type AccountDoc, type AnalysisDoc, type CommandDoc, type Collections, type Settings } from '../db.ts';
import { HttpError, notFound, parse, parseId } from '../http.ts';
import { accountInfo, freshQuote, getAnalysis, loadCandles, ordersForAccount, refreshAnalysis, rowsFor } from '../service.ts';

const HOUR = 3_600_000;
const symbolName = z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{3,20}$/, 'Nama simbol tidak valid');
const bool01 = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

function publicAccount(a: AccountDoc) {
  return {
    id: a._id.toHexString(),
    name: a.name,
    number: a.number,
    riskPct: a.riskPct,
    aggressiveMultiplier: a.aggressiveMultiplier,
    aggressiveAuto: a.aggressiveAuto,
    symbolMap: a.symbolMap,
    offsets: a.offsets,
    balance: a.balance,
    currency: a.currency,
    balanceAt: a.balanceAt,
    specSymbols: Object.keys(a.specs),
  };
}

function publicCommand(c: CommandDoc) {
  const { _id, accountId, purgeAt: _purge, ...rest } = c;
  return { id: _id.toHexString(), accountId: accountId.toHexString(), ...rest };
}

async function findAccount(db: Collections, id: unknown): Promise<AccountDoc> {
  const account = await db.accounts.findOne({ _id: parseId(id, 'Akun') });
  if (!account) throw notFound('Akun tidak ditemukan');
  return account;
}

async function refreshAll(db: Collections, settings: Settings) {
  const symbols = await db.symbols.find({ active: true }).toArray();
  for (const s of symbols) await refreshAnalysis(db, s.name, settings);
}

const accountFields = {
  name: z.string().trim().min(1).max(60),
  number: z.number().int().positive(),
  riskPct: z.number().positive().max(10),
  aggressiveMultiplier: z.number().min(1).max(10),
  aggressiveAuto: z.boolean(),
  symbolMap: z.record(z.string(), z.string().trim().min(1).max(30)),
  offsets: z.record(z.string(), z.number()),
};

const settingsSchema = z.object({
  rrThreshold: z.number().min(0).max(20),
  newsWindowHours: z.number().int().min(1).max(168),
  commandTtlHours: z.number().int().min(1).max(168),
  balanceStaleMinutes: z.number().int().min(1).max(10_080),
  quoteMaxAgeMinutes: z.number().int().min(1).max(10_080),
  sr: z.object({
    lookback: z.number().int().min(50).max(5000),
    fractal: z.number().int().min(1).max(10),
    atrPeriod: z.number().int().min(2).max(100),
    clusterAtr: z.number().positive().max(10),
    minTouches: z.number().int().min(1).max(20),
    strongBodyPct: z.number().min(0).max(1),
    strongAtr: z.number().min(0).max(10),
    strongMaxDistanceAtr: z.number().positive().max(20),
    strongPick: z.enum(['recent', 'nearest']),
    wickRatio: z.number().min(0).max(1),
    reboundMaxDistanceAtr: z.number().positive().max(20),
    bufferAtr: z.number().min(0).max(5),
    autoTpRr: z.number().positive().max(20),
    maxLinesPerSide: z.number().int().min(0).max(50),
  }).partial(),
  colors: z.object({ sr: hexColor, entry: hexColor, sltp: hexColor }).partial(),
}).partial();

const executeSchema = z.object({
  accountIds: z.array(z.string()).min(1).max(20),
  aggressive: z.boolean(),
});

export function webRoutes(db: Collections): Router {
  const router = Router();

  // --- symbols ---------------------------------------------------------------
  router.get('/symbols', async (_req, res) => {
    const settings = await getSettings(db);
    const symbols = await db.symbols.find().sort({ order: 1 }).toArray();
    const byName = new Map<string, AnalysisDoc>();
    for (const s of symbols) {
      const a = s.active ? await getAnalysis(db, s.name, settings) : await db.analyses.findOne({ _id: s.name });
      if (a) byName.set(s.name, a);
    }
    res.json({
      symbols: symbols.map((s) => {
        const a = byName.get(s.name);
        const open = a ? a.candidates.filter((c) => !c.skipped && !a.cancelled.includes(c.id)).length : 0;
        return { name: s.name, active: s.active, order: s.order, digits: s.digits, candidates: open, lastCandleAt: a?.lastCandleAt ?? null };
      }),
      colors: settings.colors,
      mt4: await db.meta.findOne({ _id: 'mt4' }, { projection: { _id: 0 } }),
    });
  });

  // Replaces the tab list: names, order and active flag. Unknown names are added.
  router.put('/symbols', async (req, res) => {
    const list = parse(z.array(z.object({ name: symbolName, active: z.boolean(), digits: z.number().int().min(0).max(8).optional() })).max(60), req.body);
    for (const [order, s] of list.entries()) {
      await db.symbols.updateOne(
        { name: s.name },
        { $set: { active: s.active, order, ...(s.digits !== undefined ? { digits: s.digits } : {}) }, $setOnInsert: { digits: s.digits ?? defaultDigits(s.name) } },
        { upsert: true },
      );
    }
    res.json({ ok: true });
  });

  // --- analysis --------------------------------------------------------------
  router.get('/analysis/:symbol', async (req, res) => {
    const symbol = parse(symbolName, req.params.symbol);
    const q = parse(z.object({ accountId: z.string().optional(), aggressive: bool01.optional() }), req.query);
    const settings = await getSettings(db);
    const analysis = await getAnalysis(db, symbol, settings);
    if (!analysis) throw notFound('Belum ada data candle untuk simbol ini');
    const account = q.accountId ? await findAccount(db, q.accountId) : null;
    const quote = freshQuote(await db.quotes.findOne({ _id: symbol }), settings);
    const candles = await loadCandles(db, symbol, settings.sr.lookback);
    res.json({
      symbol,
      digits: (await db.symbols.findOne({ name: symbol }))?.digits ?? 5,
      analyzedAt: analysis.analyzedAt,
      lastCandleAt: analysis.lastCandleAt,
      atr: analysis.atr,
      price: analysis.price,
      quote: quote ? { bid: quote.bid, ask: quote.ask, at: quote.at } : null,
      candles,
      lines: analysis.lines,
      rows: rowsFor(analysis, account, quote, settings, q.aggressive ?? false),
      account: account ? accountInfo(account, settings, q.aggressive ?? false) : null,
    });
  });

  // X: cancel one level for every account; restore undoes it.
  for (const action of ['cancel', 'restore'] as const) {
    router.post(`/orders/:id/${action}`, async (req, res) => {
      const id = parse(z.string().min(3).max(80), req.params.id);
      const symbol = id.split(':')[0]!;
      const update = action === 'cancel' ? { $addToSet: { cancelled: id } } : { $pull: { cancelled: id } };
      const result = await db.analyses.updateOne({ _id: symbol, 'candidates.id': id }, update);
      if (!result.matchedCount) throw notFound('Kandidat order tidak ditemukan (analisa mungkin sudah diperbarui)');
      res.json({ ok: true });
    });
  }

  router.get('/orders', async (req, res) => {
    const q = parse(z.object({ accountId: z.string(), aggressive: bool01.optional() }), req.query);
    res.json(await ordersForAccount(db, await findAccount(db, q.accountId), q.aggressive ?? false));
  });

  // --- execute ---------------------------------------------------------------
  router.post('/execute/preview', async (req, res) => {
    const { accountIds, aggressive } = parse(executeSchema, req.body);
    const accounts = await Promise.all(accountIds.map((id) => findAccount(db, id)));
    res.json({ accounts: await Promise.all(accounts.map((a) => ordersForAccount(db, a, aggressive))) });
  });

  // One command per account. The rows are recomputed here, never taken from the client.
  // A newer command supersedes a pending one so the EA never places two sets.
  router.post('/execute', async (req, res) => {
    const { accountIds, aggressive } = parse(executeSchema, req.body);
    const settings = await getSettings(db);
    const accounts = await Promise.all([...new Set(accountIds)].map((id) => findAccount(db, id)));
    const created: CommandDoc[] = [];
    for (const account of accounts) {
      const { rows } = await ordersForAccount(db, account, aggressive);
      const now = new Date();
      await db.commands.updateMany({ accountId: account._id, status: 'pending' }, { $set: { status: 'superseded', finishedAt: now } });
      const command: CommandDoc = {
        _id: new ObjectId(),
        accountId: account._id,
        accountNumber: account.number,
        aggressive,
        orders: rows
          .filter((r) => r.status === 'valid')
          .map((r) => ({
            ref: r.id,
            symbol: account.symbolMap[r.symbol] ?? r.symbol,
            side: r.side,
            entry: r.entry!,
            sl: r.sl!,
            tp: r.tp!,
            lot: r.lot!,
          })),
        status: 'pending',
        createdAt: now,
        expiresAt: new Date(now.getTime() + settings.commandTtlHours * HOUR),
        purgeAt: new Date(now.getTime() + 30 * 24 * HOUR),
      };
      await db.commands.insertOne(command);
      created.push(command);
    }
    res.status(201).json({ commands: created.map(publicCommand) });
  });

  router.get('/commands', async (req, res) => {
    const q = parse(z.object({ accountId: z.string().optional() }), req.query);
    const filter = q.accountId ? { accountId: parseId(q.accountId, 'Akun') } : {};
    await db.commands.updateMany({ status: 'pending', expiresAt: { $lt: new Date() } }, { $set: { status: 'expired' } });
    const commands = await db.commands.find(filter).sort({ createdAt: -1 }).limit(30).toArray();
    res.json({ commands: commands.map(publicCommand) });
  });

  // --- news (filled in stage 3) ------------------------------------------------
  router.get('/news', async (_req, res) => {
    const settings = await getSettings(db);
    const now = Date.now();
    const news = await db.news
      .find({ impact: 'high', at: { $gte: new Date(now - HOUR), $lte: new Date(now + settings.newsWindowHours * HOUR) } })
      .sort({ at: 1 })
      .toArray();
    res.json({ news: news.map(({ _id, ...n }) => ({ id: _id.toHexString(), ...n })) });
  });

  // --- settings --------------------------------------------------------------
  router.get('/settings', async (_req, res) => {
    const { _id, ...settings } = await getSettings(db);
    res.json(settings);
  });

  router.put('/settings', async (req, res) => {
    const patch = parse(settingsSchema, req.body);
    const current = await getSettings(db);
    const next: Settings = {
      ...current,
      ...patch,
      sr: { ...current.sr, ...patch.sr },
      colors: { ...current.colors, ...patch.colors },
      version: current.version + 1,
    };
    await db.settings.replaceOne({ _id: 'main' }, next, { upsert: true });
    await refreshAll(db, next);
    const { _id, ...settings } = next;
    res.json(settings);
  });

  // --- accounts ----------------------------------------------------------------
  router.get('/accounts', async (_req, res) => {
    const accounts = await db.accounts.find().sort({ name: 1 }).toArray();
    res.json({ accounts: accounts.map(publicAccount) });
  });

  router.post('/accounts', async (req, res) => {
    const input = parse(
      z.object({
        name: accountFields.name,
        number: accountFields.number,
        riskPct: accountFields.riskPct.default(0.1),
        aggressiveMultiplier: accountFields.aggressiveMultiplier.default(2),
        aggressiveAuto: accountFields.aggressiveAuto.default(true),
        symbolMap: accountFields.symbolMap.default({}),
        offsets: accountFields.offsets.default({}),
      }),
      req.body,
    );
    if (await db.accounts.findOne({ number: input.number })) throw new HttpError(409, 'Nomor akun sudah terdaftar.');
    const { key, keyHash } = newAccountKey();
    const account: AccountDoc = { _id: new ObjectId(), ...input, keyHash, balance: null, currency: null, balanceAt: null, specs: {}, createdAt: new Date() };
    await db.accounts.insertOne(account);
    res.status(201).json({ account: publicAccount(account), key });
  });

  router.put('/accounts/:id', async (req, res) => {
    const account = await findAccount(db, req.params.id);
    const patch = parse(z.object(accountFields).partial(), req.body);
    if (patch.number && patch.number !== account.number && (await db.accounts.findOne({ number: patch.number }))) {
      throw new HttpError(409, 'Nomor akun sudah terdaftar.');
    }
    await db.accounts.updateOne({ _id: account._id }, { $set: patch });
    res.json({ account: publicAccount({ ...account, ...patch }) });
  });

  router.post('/accounts/:id/key', async (req, res) => {
    const account = await findAccount(db, req.params.id);
    const { key, keyHash } = newAccountKey();
    await db.accounts.updateOne({ _id: account._id }, { $set: { keyHash } });
    res.json({ key });
  });

  router.delete('/accounts/:id', async (req, res) => {
    const account = await findAccount(db, req.params.id);
    await db.accounts.deleteOne({ _id: account._id });
    await db.commands.updateMany({ accountId: account._id, status: 'pending' }, { $set: { status: 'superseded', finishedAt: new Date() } });
    res.status(204).end();
  });

  return router;
}

export function defaultDigits(symbol: string): number {
  if (symbol.startsWith('XAU')) return 2;
  return symbol.includes('JPY') ? 3 : 5;
}
