// Candle shapes shared by tests (not a test file itself).
import { roundTo } from './sr.ts';
import type { Candle } from './types.ts';

// Gold on H4, 16 Nov 2026 in shape: two years of swings in a low range (1000-1100), the
// last ~1000 candles in a high range (1200-1300), then a fall to 1150, under every line of
// the last 3 months. 520 candles saw no line under price and placed no sell stop.
export function fallBelowRange(t0 = 0): Candle[] {
  const H4 = 14_400_000;
  const out: Candle[] = [];
  const wave = (i: number, mid: number) => mid + 45 * Math.sin((i * 2 * Math.PI) / 40);
  for (let i = 0; i < 3120; i++) {
    const fall = i >= 3100;
    const mid = i < 2000 ? 1050 : 1250;
    const c = fall ? 1250 - (i - 3099) * 5 : wave(i + 1, mid);
    const o = fall ? c + 5 : wave(i, mid);
    out.push({ t: t0 + i * H4, o: roundTo(o, 2), h: roundTo(Math.max(o, c) + 2, 2), l: roundTo(Math.min(o, c) - 2, 2), c: roundTo(c, 2) });
  }
  return out;
}

