import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { resolveFarmPaths, resolveReportedFarmPaths } from '../../src/node/farm-paths.js';
import { readLegacyStorageFacts } from '../../src/node/farm-paths-storage.js';

/**
 * A legacy home whose Run bundle store is configured and paired on a volume that
 * is not mounted, as macwork's c910ssd was on Nov 24: the node crashed at load
 * reading the store's realpath, so it never connected.
 */
function homeWithUnmountedStore(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'farm-paths-storage-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const missingRoot = path.join(root, 'Volumes/unmounted/farmslot-data/run-bundles');
  const paths = resolveFarmPaths({ home, role: 'node', env: {} });
  mkdirSync(path.dirname(paths.data.runBundles), { recursive: true });
  writeFileSync(
    path.join(path.dirname(paths.data.runBundles), 'run-bundle-retention.json'),
    JSON.stringify({ runBundleRetention: { storeRoot: missingRoot } }),
  );
  mkdirSync(paths.state.runs, { recursive: true });
  writeFileSync(
    path.join(paths.state.runs, 'bundle-store.json'),
    JSON.stringify({
      version: 1,
      id: 'store-1',
      runsDir: realpathSync(paths.state.runs),
      root: missingRoot,
    }),
  );
  return { home, paths, missingRoot };
}

test('a Run bundle store on an unmounted volume is reported unavailable, not thrown', (t) => {
  const { home, paths, missingRoot } = homeWithUnmountedStore(t);

  const facts = readLegacyStorageFacts(paths);
  assert.equal(facts.runBundles, missingRoot);
  assert.match(facts.unavailable ?? '', /unmounted\/farmslot-data\/run-bundles/);

  const reported = resolveReportedFarmPaths({ home, role: 'node', env: {} });
  assert.equal(reported.data.runBundles, missingRoot);
});

test('a Run bundle store that is present still has its pairing checked', (t) => {
  const { paths, missingRoot } = homeWithUnmountedStore(t);
  // The volume is back, but its store belongs to a different Run store.
  mkdirSync(missingRoot, { recursive: true });
  writeFileSync(path.join(missingRoot, 'store.json'), JSON.stringify({ version: 1, id: 'other' }));
  assert.throws(() => readLegacyStorageFacts(paths), /belongs to a different Run store/);
});
