import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { AccountDoc, Collections } from './db.ts';
import { HttpError, parse } from './http.ts';

const TOKEN_HOURS = 12;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// New EA key for an MT5 account: returned once, only its hash is stored.
export function newAccountKey(): { key: string; keyHash: string } {
  const key = randomBytes(24).toString('base64url');
  return { key, keyHash: sha256(key) };
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

// Fixed-window counter per key (IP). In memory: fine for one Render instance.
export function rateLimit(opts: { windowMs: number; max: number; message?: string }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      throw new HttpError(429, opts.message ?? 'Too many requests. Try again shortly.');
    }
    next();
  };
}

const unauthorized = () => new HttpError(401, 'Silakan login.');

export function authRoutes(config: Config): Router {
  const router = Router();
  const loginSchema = z.object({ password: z.string().min(1).max(200) });

  router.post(
    '/login',
    rateLimit({ windowMs: 15 * 60_000, max: 10, message: 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.' }),
    async (req, res) => {
      const { password } = parse(loginSchema, req.body);
      if (!(await bcrypt.compare(password, config.adminPasswordHash))) throw new HttpError(401, 'Password salah.');
      const expiresAt = new Date(Date.now() + TOKEN_HOURS * 3_600_000);
      const token = jwt.sign({}, config.jwtSecret, { subject: 'admin', expiresIn: `${TOKEN_HOURS}h` });
      res.json({ token, expiresAt });
    },
  );
  return router;
}

// Web routes: `Authorization: Bearer <token>` from /auth/login.
export function requireAdmin(config: Config): RequestHandler {
  return (req, _res, next) => {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorized();
    try {
      const claims = jwt.verify(token, config.jwtSecret);
      if (typeof claims === 'string' || claims.sub !== 'admin') throw unauthorized();
    } catch {
      throw unauthorized();
    }
    next();
  };
}

function apiKey(req: Request): string {
  const key = req.get('x-api-key');
  if (!key) throw new HttpError(401, 'Missing X-Api-Key.');
  return key;
}

// MT4 data EA: one shared key from the environment.
export function requireDataKey(config: Config): RequestHandler {
  return (req, _res, next) => {
    if (!sameSecret(apiKey(req), config.eaDataKey)) throw new HttpError(401, 'Invalid data key.');
    next();
  };
}

// MT5 EA: one key per account; the account is loaded so one account can never read
// another account's commands.
export function requireAccountKey(db: Collections): RequestHandler {
  return async (req, res, next) => {
    const account = await db.accounts.findOne({ keyHash: sha256(apiKey(req)) });
    if (!account) throw new HttpError(401, 'Invalid account key.');
    res.locals.account = account;
    next();
  };
}

export function keyAccount(res: Response): AccountDoc {
  return res.locals.account as AccountDoc;
}
