import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectProviderCliHealth } from './provider-cli-health.js';

test('node samples share provider failures and a pool change clears them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-provider-health-'));
  const prior = { pool: process.env.FARMSLOT_POOL_DIR, machine: process.env.MACHINE_NAME };
  process.env.FARMSLOT_POOL_DIR = root;
  process.env.MACHINE_NAME = 'fixture';
  t.after(async () => {
    if (prior.pool === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prior.pool;
    if (prior.machine === undefined) delete process.env.MACHINE_NAME;
    else process.env.MACHINE_NAME = prior.machine;
    await rm(root, { recursive: true, force: true });
  });
  const pool = path.join(root, 'fixture.json');
  await writeFile(
    pool,
    JSON.stringify({ env: { FIXTURE_PACKAGE_ROOT: path.join(root, 'missing') } }),
  );
  const [first, concurrent] = await Promise.all([
    collectProviderCliHealth(),
    collectProviderCliHealth(),
  ]);
  assert.strictEqual(first, concurrent);
  assert.equal(first[0].ok, false);
  await writeFile(pool, JSON.stringify({ env: {} }));
  assert.deepEqual(await collectProviderCliHealth(), []);
});
