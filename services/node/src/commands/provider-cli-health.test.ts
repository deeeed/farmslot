import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectProviderCliHealth, getProviderCliHealth } from './provider-cli-health.js';

test('node samples share provider failures and a pool change clears them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-provider-health-'));
  const prior = process.env.FARMSLOT_POOL_DIR;
  process.env.FARMSLOT_POOL_DIR = root;
  t.after(async () => {
    if (prior === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prior;
    await rm(root, { recursive: true, force: true });
  });
  process.env.FARMSLOT_POOL_DIR = path.join(root, 'not-created');
  assert.deepEqual(await collectProviderCliHealth('fixture'), []);
  process.env.FARMSLOT_POOL_DIR = root;
  const pool = path.join(root, 'fixture-onboard.json');
  assert.deepEqual(await collectProviderCliHealth('fixture'), []);
  await writeFile(
    pool,
    JSON.stringify({
      machine: 'fixture',
      env: { FIXTURE_PACKAGE_ROOT: path.join(root, 'missing') },
    }),
  );
  const pending = collectProviderCliHealth('fixture');
  assert(
    Array.isArray(getProviderCliHealth('fixture')),
    'metrics return the last result while probing',
  );
  const [first, concurrent] = await Promise.all([pending, collectProviderCliHealth('fixture')]);
  assert.strictEqual(first, concurrent);
  assert.equal(first[0].ok, false);
  await writeFile(pool, JSON.stringify({ machine: 'fixture', env: {} }));
  assert.deepEqual(await collectProviderCliHealth('fixture'), []);
  await writeFile(pool, '{malformed');
  const malformed = await collectProviderCliHealth('fixture');
  assert.equal(malformed[0].ok, false);
  assert.match(malformed[0].reason ?? '', /Invalid pool JSON/);
  assert(!malformed[0].reason?.includes('{malformed'));
  await rm(pool);
  assert.deepEqual(await collectProviderCliHealth('fixture'), []);
});
