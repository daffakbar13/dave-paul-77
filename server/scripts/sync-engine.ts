// The backtest runs in the browser, and the web build cannot reach ../server, so the
// pure engine files are kept as a byte-identical copy in web/src/engine. Run this after
// changing any of them; analysis/engineCopy.test.ts fails while the copies differ.
import { copyFileSync } from 'node:fs';
import { ENGINE_FILES } from '../src/analysis/engineFiles.ts';

for (const f of ENGINE_FILES) {
  copyFileSync(new URL(`../src/analysis/${f}`, import.meta.url), new URL(`../../web/src/engine/${f}`, import.meta.url));
  console.log(`copied ${f}`);
}
