import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { newAccountKey } from '../auth.ts';
import { getSettings, type AccountDoc, type AnalysisDoc, type CommandDoc, type Collections, type Settings } from '../db.ts';
import { HttpError, notFound, parse, parseId } from '../http.ts';
import { journalFor } from '../journal.ts';
import { defaultMinSlPips, parseTpl, setManualLines } from '../lines.ts';
import { aggressiveContext, isAffected, newsStatus, refreshNews, upcomingRed, type NewsProvider } from '../news.ts';
import { accountInfo, freshQuote, getAnalysis, loadCandles, ordersForAccount, refreshAnalysis, rowsFor } from '../service.ts';

const HOUR = 3_600_000;
const symbolName = z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{3,20}$/, 'Nama simbol tidak valid');
const aggressiveMode = z.enum(['auto', 'on', 'off']);
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
  const { _id, accountId, purgeAt: _purge, plans: _plans, ...rest } = c;
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
    lineSource: z.enum(['auto', 'manual']),
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
    orderModel: z.enum(['ladder', 'strong']),
    entryGap: z.number().min(0).max(2),
    slGap: z.number().min(0).max(2),
    tpGap: z.number().min(0).max(1),
    minDistanceAtr: z.number().min(0).max(10),
    slSource: z.enum(['candle', 'ladder']),
    slStrongAtr: z.number().min(0).max(5),
    slMaxRiskAtr: z.number().positive().max(10),
  }).partial(),
  colors: z.object({ sr: hexColor, entry: hexColor, sltp: hexColor }).partial(),
}).partial();

const executeSchema = z.object({
  accountIds: z.array(z.string()).min(1).max(20),
  aggressive: aggressiveMode,
});

export function webRoutes(db: Collections, news: NewsProvider | null): Router {
  const router = Router();

  // Aggressive for this request; refreshes the calendar first when its cache is stale.
  async function aggressiveFor(mode: z.infer<typeof aggressiveMode>) {
    const settings = await getSettings(db);
    if (mode === 'auto') await refreshNews(db, news);
    return aggressiveContext(db, settings, mode);
  }

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
        return {
          name: s.name,
          active: s.active,
          order: s.order,
          digits: s.digits,
          candidates: open,
          lastCandleAt: a?.lastCandleAt ?? null,
          manualLines: s.manualLines?.length ?? 0,
          manualLinesAt: s.manualLinesAt ?? null,
          manualLinesSource: s.manualLinesSource ?? null,
          minSlPips: s.minSlPips ?? defaultMinSlPips(s.name),
        };
      }),
      colors: settings.colors,
      mt4: await db.meta.findOne({ _id: 'mt4' }, { projection: { _id: 0 } }),
    });
  });

  // Replaces the tab list: names, order and active flag. Unknown names are added.
  router.put('/symbols', async (req, res) => {
    const list = parse(
      z.array(z.object({
        name: symbolName,
        active: z.boolean(),
        digits: z.number().int().min(0).max(8).optional(),
        minSlPips: z.number().min(0).max(1000).optional(),
      })).max(60),
      req.body,
    );
    const settings = await getSettings(db);
    for (const [order, s] of list.entries()) {
      const before = await db.symbols.findOne({ name: s.name });
      await db.symbols.updateOne(
        { name: s.name },
        {
          $set: {
            active: s.active,
            order,
            ...(s.digits !== undefined ? { digits: s.digits } : {}),
            ...(s.minSlPips !== undefined ? { minSlPips: s.minSlPips } : {}),
          },
          $setOnInsert: { digits: s.digits ?? defaultDigits(s.name) },
        },
        { upsert: true },
      );
      const minSlChanged = s.minSlPips !== undefined && s.minSlPips !== (before?.minSlPips ?? defaultMinSlPips(s.name));
      if (minSlChanged) await refreshAnalysis(db, s.name, settings);
    }
    res.json({ ok: true });
  });

  // The user's own S/R lines for one pair; an empty list goes back to automatic lines.
  router.put('/symbols/:symbol/lines', async (req, res) => {
    const symbol = parse(symbolName, req.params.symbol);
    const { lines } = parse(z.object({ lines: z.array(z.number().positive().finite()).max(300) }), req.body);
    if (!(await db.symbols.findOne({ name: symbol }))) throw notFound('Pair tidak ditemukan');
    await setManualLines(db, symbol, lines, 'web');
    res.json({ symbol, lines: lines.length });
  });

  // MT4/MT5 chart templates (.tpl) with horizontal lines, one per pair.
  router.post('/lines/import-tpl', async (req, res) => {
    const { files } = parse(z.object({ files: z.array(z.object({ name: z.string().max(200), content: z.string().max(500_000) })).min(1).max(40) }), req.body);
    const results: { file: string; symbol?: string; lines?: number; error?: string }[] = [];
    for (const f of files) {
      const tpl = parseTpl(f.content);
      if (!tpl) {
        results.push({ file: f.name, error: 'Bukan template chart (tidak ada symbol=)' });
        continue;
      }
      // a broker suffix (EURUSDm, EURUSD.pro) falls back to the 6-letter pair
      const sym = (await db.symbols.findOne({ name: tpl.symbol })) ?? (await db.symbols.findOne({ name: tpl.symbol.slice(0, 6) }));
      const name = tpl.symbol;
      if (!sym) {
        results.push({ file: f.name, symbol: name, error: 'Pair belum ada di daftar' });
        continue;
      }
      if (!tpl.lines.length) {
        results.push({ file: f.name, symbol: sym.name, error: 'Tidak ada garis horizontal' });
        continue;
      }
      await setManualLines(db, sym.name, tpl.lines, 'import');
      results.push({ file: f.name, symbol: sym.name, lines: tpl.lines.length });
    }
    res.json({ results });
  });

  // --- analysis --------------------------------------------------------------
  router.get('/analysis/:symbol', async (req, res) => {
    const symbol = parse(symbolName, req.params.symbol);
    const q = parse(z.object({ accountId: z.string().optional(), aggressive: aggressiveMode.default('off') }), req.query);
    const settings = await getSettings(db);
    const aggressive = await aggressiveFor(q.aggressive);
    const analysis = await getAnalysis(db, symbol, settings);
    if (!analysis) throw notFound('Belum ada data candle untuk simbol ini');
    const account = q.accountId ? await findAccount(db, q.accountId) : null;
    const quote = freshQuote(await db.quotes.findOne({ _id: symbol }), settings);
    const candles = await loadCandles(db, symbol, settings.sr.lookback);
    const sym = await db.symbols.findOne({ name: symbol });
    res.json({
      symbol,
      digits: sym?.digits ?? 5,
      analyzedAt: analysis.analyzedAt,
      lastCandleAt: analysis.lastCandleAt,
      atr: analysis.atr,
      price: analysis.price,
      quote: quote ? { bid: quote.bid, ask: quote.ask, at: quote.at } : null,
      candles,
      lines: analysis.lines,
      referenceLines: sym?.manualLines ?? [], // the user's own lines, drawn for comparison
      rows: rowsFor(analysis, account, quote, settings, aggressive),
      account: account ? accountInfo(account, settings) : null,
      newsAffected: aggressive.mode === 'auto' && isAffected(symbol, aggressive.affected),
    });
  });

  // Undo every X at once: one pair, or all pairs when no symbol is given.
  router.post('/orders/restore-all', async (req, res) => {
    const { symbol } = parse(z.object({ symbol: symbolName.optional() }).default({}), req.body ?? {});
    const filter = symbol ? { _id: symbol, 'cancelled.0': { $exists: true } } : { 'cancelled.0': { $exists: true } };
    const docs = await db.analyses.find(filter, { projection: { cancelled: 1 } }).toArray();
    const restored = docs.reduce((n, d) => n + d.cancelled.length, 0);
    if (docs.length) await db.analyses.updateMany({ _id: { $in: docs.map((d) => d._id) } }, { $set: { cancelled: [] } });
    res.json({ restored });
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
    const q = parse(z.object({ accountId: z.string(), aggressive: aggressiveMode.default('off') }), req.query);
    res.json(await ordersForAccount(db, await findAccount(db, q.accountId), await aggressiveFor(q.aggressive)));
  });

  // --- execute ---------------------------------------------------------------
  router.post('/execute/preview', async (req, res) => {
    const { accountIds, aggressive } = parse(executeSchema, req.body);
    const accounts = await Promise.all(accountIds.map((id) => findAccount(db, id)));
    const ctx = await aggressiveFor(aggressive);
    res.json({ accounts: await Promise.all(accounts.map((a) => ordersForAccount(db, a, ctx))) });
  });

  // One command per account. The rows are recomputed here, never taken from the client.
  // A newer command supersedes a pending one so the EA never places two sets.
  router.post('/execute', async (req, res) => {
    const { accountIds, aggressive } = parse(executeSchema, req.body);
    const settings = await getSettings(db);
    const accounts = await Promise.all([...new Set(accountIds)].map((id) => findAccount(db, id)));
    const ctx = await aggressiveFor(aggressive);
    const created: CommandDoc[] = [];
    for (const account of accounts) {
      const { rows } = await ordersForAccount(db, account, ctx);
      const valid = rows.filter((r) => r.status === 'valid');
      const analyses = new Map((await db.analyses.find({ _id: { $in: [...new Set(valid.map((r) => r.symbol))] } }).toArray()).map((a) => [a._id, a]));
      const now = new Date();
      await db.commands.updateMany({ accountId: account._id, status: 'pending' }, { $set: { status: 'superseded', finishedAt: now } });
      const command: CommandDoc = {
        _id: new ObjectId(),
        accountId: account._id,
        accountNumber: account.number,
        aggressive,
        orders: valid.map((r) => ({
            ref: r.id,
            symbol: account.symbolMap[r.symbol] ?? r.symbol,
            side: r.side,
            entry: r.entry!,
            sl: r.sl!,
            tp: r.tp!,
            lot: r.lot!,
          })),
        plans: valid.map((r) => {
          const a = analyses.get(r.symbol);
          return {
            ref: r.id,
            aggressive,
            line: r.line,
            lineSource: a?.lines.find((l) => l.price === r.line)?.source ?? 'auto',
            entry: r.entry!,
            sl: r.sl!,
            tp: r.tp!,
            tpAuto: r.tpAuto,
            ...(r.slFrom ? { slFrom: r.slFrom } : {}),
            lot: r.lot!,
            risk: r.risk,
            rr: r.rr,
            multiplier: r.multiplier,
            atr: a?.atr ?? null,
            newsAffected: ctx.mode === 'auto' && isAffected(r.symbol, ctx.affected),
          };
        }),
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

  // --- trade journal ---------------------------------------------------------
  // Closed trades of one account in [from, to) with the audit; the web sends the month
  // bounds in WIB.
  router.get('/journal', async (req, res) => {
    const q = parse(z.object({ accountId: z.string(), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }), req.query);
    const account = await findAccount(db, q.accountId);
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(to > from)) throw new HttpError(400, 'Periode tidak valid');
    res.json({ currency: account.currency, ...(await journalFor(db, account._id, from, to)) });
  });

  // --- news ------------------------------------------------------------------
  // Red news in the window plus the currencies that switch automatic Aggressive on.
  async function newsPayload() {
    const settings = await getSettings(db);
    const items = await upcomingRed(db, settings);
    const ctx = await aggressiveContext(db, settings, 'auto');
    return {
      news: items.map(({ _id, ...n }) => ({ id: _id.toHexString(), ...n })),
      affected: [...ctx.affected].sort(),
      windowHours: settings.newsWindowHours,
      status: await newsStatus(db),
    };
  }

  router.get('/news', async (_req, res) => {
    await refreshNews(db, news);
    res.json(await newsPayload());
  });

  router.post('/news/refresh', async (_req, res) => {
    await refreshNews(db, news, true);
    res.json(await newsPayload());
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
