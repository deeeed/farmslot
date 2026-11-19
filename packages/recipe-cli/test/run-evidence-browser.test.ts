import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

test('the shared evidence entry bundles for browser consumers without execution or filesystem code', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../adapter-sdk/src/evidence.ts', import.meta.url))],
    alias: {
      '@farmslot/recipe-runner/evidence': fileURLToPath(
        new URL('../../recipe-runner/src/evidence/index.ts', import.meta.url),
      ),
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  assert.ok(bundle.outputFiles[0]?.contents.length);
});
