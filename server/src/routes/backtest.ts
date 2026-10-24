import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { Router } from 'express';
import { z } from 'zod';
import { getSettings, type Collections } from '../db.ts';
import { HttpError, parse } from '../http.ts';
import { loadData } from './calibration.ts';

const gzipAsync = promisify(gzip);
const symbolName = z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{3,20}$/, 'Nama simbol tidak valid');
const querySchema = z.object({ symbols: z.string().optional() });

// The backtest runs in the browser (a Web Worker): replaying 22 years of 14 pairs is
// about 15 s of CPU, too much for this host's slice of a CPU. The server only hands over
// the stored D1 candles and the saved S/R settings, compactly (arrays) and gzipped.
export function backtestRoutes(db: Collections): Router {
  const router = Router();

  router.get('/candles', async (req, res) => {
    const { symbols: raw } = parse(querySchema, req.query);
    const wanted = raw ? z.array(symbolName).max(60).parse(raw.split(',').filter(Boolean)) : null;
    const active = (await db.symbols.find({ active: true }).sort({ order: 1 }).toArray()).map((s) => s.name);
    const names = wanted?.length ? wanted : active;
    if (!names.length) throw new HttpError(400, 'Belum ada pair aktif');
    const data = await loadData(db, names);
    if (!data.size) throw new HttpError(404, 'Belum ada data candle untuk pair ini');
    const settings = await getSettings(db);
    const body = JSON.stringify({
      sr: settings.sr,
      symbols: [...data].map(([name, d]) => ({
        name,
        digits: d.digits,
        inputs: d.inputs ?? {},
        candles: d.candles.map((c) => [c.t, c.o, c.h, c.l, c.c]),
      })),
    });
    res.set({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding', 'Cache-Control': 'no-store' });
    if (/\bgzip\b/.test(req.get('accept-encoding') ?? '')) {
      res.set('Content-Encoding', 'gzip').send(await gzipAsync(body));
    } else {
      res.send(body);
    }
  });

  return router;
}
