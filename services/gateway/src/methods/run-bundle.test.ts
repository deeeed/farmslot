import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runBundleExport, runBundleImport } from './run-bundle.js';

// Arthur 11-02: bundle export and import copy whole payloads, so they stop at the free-space
// floor before writing anything.
test('bundle export and import refuse below the free-space floor', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'run-bundle-floor-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const previous = process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB;
  process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB = '100000000';
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB;
    else process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB = previous;
  });
  const outputPath = path.join(tmp, 'exports/runs.farmslot-bundle');
  await assert.rejects(
    runBundleExport({ outputPath, runId: 'run-floor' }),
    /under the 100000000\.0 GB floor/,
  );
  assert.equal(existsSync(path.dirname(outputPath)), false);
  await assert.rejects(
    runBundleImport({ bundlePath: path.join(tmp, 'missing.farmslot-bundle') }),
    /under the 100000000\.0 GB floor/,
  );
});
