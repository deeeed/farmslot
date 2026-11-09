import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import * as paths from '../../src/node/farm-paths.js';
import * as home from '../../src/node/farmslot-home.js';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'farm-paths-review-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('shared enumeration includes config files, backlog specs and indexed log paths, without metadata', (t) => {
  const root = fixture(t);
  const report = paths.resolveFarmPaths({
    role: 'gateway',
    home: root,
    checkoutRoot: root,
    env: { FARMSLOT_EXTRA_LOG_DIRS: path.join(root, 'extra') },
  });
  const entries = Object.fromEntries(paths.farmPathEntries(report));
  assert.equal(entries['configFiles.sources'], path.join(root, 'sources.json'));
  assert.equal(entries['state.backlogSpecs'], path.join(root, '.backlog/specs'));
  assert.equal(entries['state.extraLogDirs.0'], path.join(root, 'extra'));
  for (const key of ['role', 'layout', 'instance', 'envOverrides.0', 'data', 'code.toString'])
    assert.equal(entries[key], undefined);
  assert.equal(
    new Set(paths.farmPathEntries(report).map(([key]) => key)).size,
    Object.keys(entries).length,
  );
});

test('home expansion is shared and leaves relative paths and named-user tildes alone', (t) => {
  const root = fixture(t);
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  assert.equal(home.expandHome('~'), root);
  assert.equal(
    home.expandHome('~'),
    paths.resolveFarmPaths({ role: 'node', home: '~', env: {} }).home,
  );
  assert.equal(home.expandHome('~/child'), path.join(home.expandHome('~'), 'child'));
  assert.equal(home.expandHome('~someone/child'), '~someone/child');
  assert.equal(home.expandHome('relative/child'), 'relative/child');
});

test('legacy reports follow retention configuration and durable pairing without writing or caching facts', (t) => {
  const root = fixture(t);
  const home = path.join(root, 'home');
  const runs = path.join(root, 'runs');
  const migrated = path.join(root, 'volume/migrated');
  for (const dir of [home, runs, migrated]) mkdirSync(dir, { recursive: true });
  const opts = {
    role: 'gateway' as const,
    home,
    checkoutRoot: root,
    env: { FARMSLOT_RUNS_DIR: runs },
  };
  const config = path.join(home, 'run-bundle-retention.json');
  writeFileSync(config, JSON.stringify({ runBundleRetention: { storeRoot: migrated } }));
  const before = readdirSync(root, { recursive: true });
  assert.equal(paths.resolveReportedFarmPaths(opts).data.runBundles, migrated);
  assert.deepEqual(readdirSync(root, { recursive: true }), before);
  const binding = { version: 1, id: 'migrated-store', runsDir: runs, root: migrated };
  writeFileSync(path.join(runs, 'bundle-store.json'), JSON.stringify(binding));
  writeFileSync(path.join(migrated, 'store.json'), JSON.stringify(binding));
  const paired = readdirSync(root, { recursive: true });
  assert.equal(paths.resolveReportedFarmPaths(opts).data.runBundles, migrated);
  assert.deepEqual(readdirSync(root, { recursive: true }), paired);
  rmSync(config);
  assert.equal(paths.resolveReportedFarmPaths(opts).data.runBundles, migrated);
  assert.equal(
    paths.resolveFarmPaths({ ...opts, legacyFacts: { runBundles: migrated } }).data.runBundles,
    migrated,
  );
  assert.equal(paths.resolveFarmPaths(opts).data.runBundles, path.join(home, 'run-bundles'));
  mkdirSync(path.join(root, 'different'));
  writeFileSync(
    config,
    JSON.stringify({ runBundleRetention: { storeRoot: path.join(root, 'different') } }),
  );
  assert.throws(() => paths.resolveReportedFarmPaths(opts), /configured root/);
  rmSync(config);
  writeFileSync(
    path.join(migrated, 'store.json'),
    JSON.stringify({ ...binding, id: 'wrong-owner' }),
  );
  assert.throws(() => paths.resolveReportedFarmPaths(opts), /different Run store/);
  writeFileSync(
    path.join(runs, 'bundle-store.json'),
    JSON.stringify({ ...binding, runsDir: root }),
  );
  assert.throws(() => paths.resolveReportedFarmPaths(opts), /canonical Run store/);
});

test('storage reports use the legacy bundle owner home and layout 2 skips legacy facts', (t) => {
  const root = fixture(t);
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const runs = path.join(root, 'runs');
  const owner = path.join(runs, 'bundle-home');
  mkdirSync(owner, { recursive: true });
  const store = path.join(root, 'external-store');
  writeFileSync(
    path.join(owner, 'run-bundle-retention.json'),
    JSON.stringify({ runBundleRetention: { storeRoot: store } }),
  );
  assert.equal(
    paths.resolveReportedFarmPaths({ role: 'node', env: { FARMSLOT_RUNS_DIR: runs } }).data
      .runBundles,
    store,
  );
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config/instance.json'), '{"layout":2}');
  mkdirSync(path.join(root, 'config/run-bundle-retention.json'));
  assert.equal(
    paths.resolveReportedFarmPaths({ role: 'node', home: root, env: {} }).data.runBundles,
    path.join(root, 'data/run-bundles'),
  );
});
