import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';

import { resolveCurrentSlot } from './slot-context.js';

test('CLI slot context uses the gateway pool override and keeps the legacy default', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cli-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pool = path.join(root, 'pool');
  const otherPool = path.join(root, 'other-pool');
  const repo = path.join(root, 'repo');
  for (const dir of [pool, otherPool, repo]) mkdirSync(dir);
  writeFileSync(
    path.join(pool, 'fixture.json'),
    JSON.stringify({ slots: [{ id: 'default', repo }] }),
  );
  writeFileSync(
    path.join(otherPool, 'fixture.json'),
    JSON.stringify({ slots: [{ id: 'override', repo }] }),
  );
  const prior = process.env.FARMSLOT_POOL_DIR;
  t.after(() => {
    if (prior === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prior;
  });
  delete process.env.FARMSLOT_POOL_DIR;
  assert.equal(resolveCurrentSlot(repo, root)?.slotId, 'default');
  assert.equal(currentFarmPaths('gateway', process.env, root).pool, pool);
  process.env.FARMSLOT_POOL_DIR = otherPool;
  assert.equal(resolveCurrentSlot(repo, root)?.slotId, 'override');
});
