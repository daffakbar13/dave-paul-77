// The web sends X-Lang ('id' default, 'en'); messages the server writes for people pick
// their language from it with tr('Indonesian', 'English'). EAs send no header: Indonesian.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

export type Lang = 'id' | 'en';

const store = new AsyncLocalStorage<Lang>();

export const langMiddleware: RequestHandler = (req, _res, next) => {
  store.run(req.get('x-lang') === 'en' ? 'en' : 'id', next);
};

export const tr = (id: string, en: string): string => (store.getStore() === 'en' ? en : id);

// Fixed messages written once at import (schema messages) are translated when sent.
const FIXED_EN: Record<string, string> = {
  'Nama simbol tidak valid': 'Invalid symbol name',
  'Tanggal harus YYYY-MM-DD': 'Date must be YYYY-MM-DD',
  'SL harus di sisi rugi entry': 'SL must be on the losing side of the entry',
  'TP harus di sisi untung entry': 'TP must be on the winning side of the entry',
  'OHLC tidak konsisten': 'Inconsistent OHLC',
  'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.': 'Too many login attempts. Try again in 15 minutes.',
};

export const trFixed = (text: string): string => (store.getStore() === 'en' ? FIXED_EN[text] ?? text : text);
