import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ENGINE_FILES } from './engineFiles.ts';

describe('web engine copy', () => {
  for (const f of ENGINE_FILES) {
    it(`${f} matches web/src/engine (run npm run sync:engine)`, () => {
      const a = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      const b = readFileSync(new URL(`../../../web/src/engine/${f}`, import.meta.url), 'utf8');
      assert.equal(b, a);
    });
  }
});
