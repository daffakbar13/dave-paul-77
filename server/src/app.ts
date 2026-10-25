import express, { type Express } from 'express';
import { authRoutes, rateLimit, requireAdmin } from './auth.ts';
import type { Config } from './config.ts';
import type { Collections } from './db.ts';
import { errorHandler, unknownRoute } from './http.ts';
import { backtestRoutes } from './routes/backtest.ts';
import { backtestsRoutes } from './routes/backtests.ts';
import { calibrationRoutes } from './routes/calibration.ts';
import { eaRoutes } from './routes/ea.ts';
import { webRoutes } from './routes/web.ts';
import { providerFromEnv } from './news.ts';

export function createApp(db: Collections, config: Config): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render sits behind one proxy; rate limits need the real IP

  // The web (Vercel) calls from another origin; only listed origins. EAs send no Origin.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.corsOrigins.includes(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        Vary: 'Origin',
      });
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // A candle batch (up to 10,000 D1 candles, about 1 MB) is the largest body; everything else is small.
  app.use('/api/ea', rateLimit({ windowMs: 60_000, max: 120 }), express.json({ limit: '2mb' }), eaRoutes(db, config), unknownRoute);
  // a saved backtest carries its trades (~30k compact rows, a few MB)
  app.use('/api/backtests', rateLimit({ windowMs: 60_000, max: 120 }), requireAdmin(config), express.json({ limit: '10mb' }), backtestsRoutes(db), unknownRoute);
  app.use('/api', rateLimit({ windowMs: 60_000, max: 300 }), express.json({ limit: '100kb' }));
  app.use('/api/auth', authRoutes(config));
  app.use('/api/backtest', requireAdmin(config), backtestRoutes(db));
  app.use('/api/calibration', requireAdmin(config), calibrationRoutes(db));
  app.use('/api', requireAdmin(config), webRoutes(db, providerFromEnv(config.newsSource, config.newsWorkerUrl)));

  app.use(unknownRoute);
  app.use(errorHandler);
  return app;
}
