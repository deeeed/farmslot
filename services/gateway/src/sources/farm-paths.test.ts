import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('empty legacy sources override keeps the historical missing-declarations fallback', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sources-paths-'));
  const previousHome = process.env.FARMSLOT_HOME;
  const previousConfig = process.env.FARMSLOT_SOURCES_CONFIG;
  t.after(() => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.FARMSLOT_SOURCES_CONFIG;
    else process.env.FARMSLOT_SOURCES_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.FARMSLOT_HOME = root;
  process.env.FARMSLOT_SOURCES_CONFIG = '';
  const { initializeSources } = await import('./runtime.js');
  await assert.doesNotReject(initializeSources());
});
