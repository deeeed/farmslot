import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { currentFarmPaths, resolveReportedFarmPaths } from '@farmslot/protocol/node/farm-paths';

import { resolveRunsDir } from './paths.js';
import { migrateRunBundleStore, openRunBundleStore } from './retained.js';

test('run-bundle follows gateway raw run overrides and preserves the legacy default', () => {
  const root = path.resolve('fixture-checkout');
  assert.equal(resolveRunsDir(root, {}), path.join(root, '.runs'));
  for (const value of ['relative/runs', '~/runs', '/absolute/runs']) {
    const env = { FARMSLOT_RUNS_DIR: value };
    assert.equal(resolveRunsDir(root, env), value);
    assert.equal(resolveRunsDir(root, env), currentFarmPaths('gateway', env, root).state.runs);
  }
});

test('FarmPaths reports the active store after a real run-bundle migration', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bundle-path-report-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const runsDir = path.join(root, 'runs');
  const targetRoot = path.join(root, 'volume-store');
  await openRunBundleStore({ home, runsDir, create: true });
  const result = await migrateRunBundleStore({
    home,
    runsDir,
    targetRoot,
    assertWriteRoom: async () => {},
  });
  const report = resolveReportedFarmPaths({
    home,
    role: 'gateway',
    checkoutRoot: root,
    env: { FARMSLOT_RUNS_DIR: runsDir },
  });
  assert.equal(result.store.root, targetRoot);
  assert.equal(report.data.runBundles, (await openRunBundleStore({ home, runsDir })).root);
});

test('a new layout-2 bundle store creates its owner at the resolved data root', async (t) => {
  const started = performance.now();
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'layout-two-bundle-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.after(() => assert.ok(performance.now() - started < 5000));
  mkdirSync(path.join(home, 'config'));
  writeFileSync(path.join(home, 'config/instance.json'), JSON.stringify({ layout: 2 }));
  const runsDir = path.join(home, 'state/runs');
  const store = await openRunBundleStore({ home, runsDir, create: true });
  assert.equal(store.root, path.join(home, 'data/run-bundles'));
  assert.deepEqual(await openRunBundleStore({ home, runsDir }), store);
});
