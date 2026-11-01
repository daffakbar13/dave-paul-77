// Two UI languages, Indonesian (default) and English. Texts sit next to the code that
// shows them as pairs: t('Simpan', 'Save'). The choice is kept per browser.
import { useSyncExternalStore } from 'react';

export type Lang = 'id' | 'en';

const LANG_KEY = 'dp77-lang';

function stored(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'id';
  } catch {
    return 'id';
  }
}

let current: Lang = stored();
const listeners = new Set<() => void>();
document.documentElement.lang = current;

export const getLang = (): Lang => current;

export function setLang(lang: Lang) {
  current = lang;
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // per-viewer convenience only
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// Outside components (helpers, labels built once): reads the language at call time.
export const tr = (id: string, en: string): string => (current === 'en' ? en : id);

// Number/date locale of the current language.
export const locale = (): string => (current === 'en' ? 'en-GB' : 'id-ID');

// In components: re-renders when the language changes.
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang);
}

export function useT(): (id: string, en: string) => string {
  const lang = useLang();
  return (id, en) => (lang === 'en' ? en : id);
}

// Texts the server or the shared engine produce in Indonesian (skip reasons, ...) that
// come back unchanged; the server translates its own messages from the X-Lang header.
const ENGINE_TEXT: [RegExp, string][] = [
  [/^Candle kuat dan pantulan tidak ditemukan$/, 'No strong candle and no rebound found'],
  [/^Candle kuat tidak ditemukan$/, 'No strong candle found'],
  [/^Pantulan tidak ditemukan$/, 'No rebound found'],
  [/^Garis berikutnya terlalu dekat untuk TP$/, 'Next line too close for a TP'],
  [/^Terlalu dekat harga$/, 'Too close to price'],
  [/^Entry sama dengan garis (.+)$/, 'Same entry as line $1'],
  // news fetch errors, stored by the server when they happen
  [/^Format kalender (worker )?tidak dikenal$/, 'Unknown $1calendar format'],
  [/^Kalender worker terakhir berhasil (\d+) jam lalu/, 'Worker calendar last succeeded $1 h ago'],
  [/^Kalender worker belum pernah berhasil/, 'Worker calendar never succeeded'],
];

export function engineText(text: string | undefined): string | undefined {
  if (!text || current === 'id') return text;
  for (const [re, en] of ENGINE_TEXT) if (re.test(text)) return text.replace(re, en);
  return text;
}
