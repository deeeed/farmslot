import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { ProviderCliHealth } from '@farmslot/protocol';

import { collectProviderCliHealth, getProviderCliHealth } from './provider-cli-health.js';

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-provider-health-'));
  const prior = process.env.FARMSLOT_POOL_DIR;
  process.env.FARMSLOT_POOL_DIR = root;
  t.after(async () => {
    if (prior === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = prior;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('node samples share provider failures and a pool change clears them', async (t) => {
  const root = await fixture(t);
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

test('a timed-out probe waits for load to fall and gets only one retry', async (t) => {
  const root = await fixture(t);
  let load = 178;
  t.mock.method(os, 'loadavg', () => [load, load, load]);
  t.mock.method(os, 'availableParallelism', () => 16);
  t.mock.timers.enable({ apis: ['Date'] });
  const pool = path.join(root, 'fixture.json');
  await writeFile(pool, JSON.stringify({ machine: 'retry', env: { TOOL_PACKAGE_ROOT: root } }));
  let calls = 0;
  const probe = async (): Promise<ProviderCliHealth> => {
    calls++;
    return {
      root,
      packageName: 'fixture',
      expectedVersion: '1.2.3',
      ok: false,
      status: 'probe-timeout',
      loadAvg1: 178,
      reason: 'Probe timed out under load',
      checkedAt: new Date().toISOString(),
      binaries: [],
    };
  };
  assert.equal((await collectProviderCliHealth('retry', probe))[0].status, 'probe-timeout');
  t.mock.timers.tick(60_001);
  await collectProviderCliHealth('retry', probe);
  assert.equal(calls, 1, 'no repeated binary launches while load remains high');
  load = 22;
  const retried = await collectProviderCliHealth('retry', probe);
  assert.equal(calls, 2);
  assert.equal(retried[0].retryAttempted, true);
  load = 1;
  t.mock.timers.tick(60_001);
  await collectProviderCliHealth('retry', probe);
  assert.equal(calls, 2, 'a failed retry stays unverified without looping');

  await writeFile(
    pool,
    JSON.stringify({
      machine: 'retry',
      env: { TOOL_PACKAGE_ROOT: root },
      revision: 2,
    }),
  );
  await collectProviderCliHealth('retry', probe);
  assert.equal(calls, 2, 'an unrelated pool edit cannot grant extra retries');
  // A new provider selection starts a qualification independent of the old timeout.
  const nextRoot = path.join(root, 'next');
  await writeFile(pool, JSON.stringify({ machine: 'retry', env: { TOOL_PACKAGE_ROOT: nextRoot } }));
  const verified = await collectProviderCliHealth('retry', async (selected) => ({
    ...(await probe()),
    root: selected,
    ok: true,
    status: 'verified',
    reason: undefined,
  }));
  assert.equal(verified[0].ok, true);
});

test('a successful load-drop retry publishes verified health', async (t) => {
  const root = await fixture(t);
  let load = 178;
  t.mock.method(os, 'loadavg', () => [load, load, load]);
  t.mock.method(os, 'availableParallelism', () => 16);
  await writeFile(
    path.join(root, 'pool.json'),
    JSON.stringify({ machine: 'recovery', env: { TOOL_PACKAGE_ROOT: root } }),
  );
  let calls = 0;
  const probe = async (): Promise<ProviderCliHealth> => ({
    root,
    packageName: 'fixture',
    expectedVersion: '1.2.3',
    ok: ++calls > 1,
    status: calls > 1 ? 'verified' : 'probe-timeout',
    loadAvg1: load,
    checkedAt: new Date().toISOString(),
    binaries: [],
  });
  await collectProviderCliHealth('recovery', probe);
  load = 22;
  const health = await collectProviderCliHealth('recovery', probe);
  assert.equal(calls, 2);
  assert.equal(health[0].status, 'verified');
  assert.equal(health[0].ok, true);
  assert.equal(health[0].retryAttempted, true);
});

test('confirmed drift survives a later sample timeout until successful requalification', async (t) => {
  const root = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'] });
  let load = 178;
  t.mock.method(os, 'loadavg', () => [load, load, load]);
  t.mock.method(os, 'availableParallelism', () => 16);
  await writeFile(
    path.join(root, 'pool.json'),
    JSON.stringify({
      machine: 'drift-timeout',
      env: { TOOL_PACKAGE_ROOT: root },
    }),
  );
  let calls = 0;
  const probe = async (): Promise<ProviderCliHealth> => {
    calls++;
    return {
      root,
      packageName: 'fixture',
      expectedVersion: '1.2.3',
      ok: calls > 2,
      status: calls === 1 ? 'version-mismatch' : calls === 2 ? 'probe-timeout' : 'verified',
      reason:
        calls === 1
          ? '1.0.0, expected 1.2.3'
          : calls === 2
            ? 'Probe timed out under load'
            : undefined,
      loadAvg1: load,
      checkedAt: new Date().toISOString(),
      binaries: [],
    };
  };
  const mismatch = (await collectProviderCliHealth('drift-timeout', probe))[0];
  t.mock.timers.tick(60_001);
  const timeout = (await collectProviderCliHealth('drift-timeout', probe))[0];
  assert.equal(timeout.status, 'probe-timeout');
  assert.deepEqual(timeout.confirmedMismatch, {
    checkedAt: mismatch.checkedAt,
    reason: mismatch.reason,
  });
  await writeFile(
    path.join(root, 'pool.json'),
    JSON.stringify({
      machine: 'drift-timeout',
      env: { TOOL_PACKAGE_ROOT: root },
      revision: 2,
    }),
  );
  assert.deepEqual(
    (await collectProviderCliHealth('drift-timeout', probe))[0].confirmedMismatch,
    timeout.confirmedMismatch,
  );
  assert.equal(calls, 2, 'the timeout still waits for load to fall');
  load = 22;
  const verified = (await collectProviderCliHealth('drift-timeout', probe))[0];
  assert.equal(calls, 3);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.confirmedMismatch, undefined);
});
