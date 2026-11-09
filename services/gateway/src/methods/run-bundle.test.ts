import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, mock, test } from 'node:test';

// Arthur 11-02: bundle export and import copy whole payloads through several destinations, any
// of which may be its own volume. Each destination is checked before anything is written.
const checked: string[] = [];
let refused: string | null = null;
let configuredRoot: string | undefined;
const rootChecks: string[] = [];
const realGuard = await import('../core/heavy-write-room.js');
mock.module('../core/heavy-write-room.js', {
  namedExports: {
    ...realGuard,
    assertHeavyWriteRootPresent: async (dir: string) => {
      rootChecks.push(dir);
      if (dir === refused)
        throw new realGuard.HeavyWriteRefusedError('configured store volume is missing');
    },
    assertHeavyWriteRoom: async (dir: string) => {
      checked.push(dir);
      if (dir === refused)
        throw new realGuard.HeavyWriteRefusedError(`Refusing to write ${dir}: under the floor`);
    },
  },
});
const wrote: string[] = [];
const realBundles = await import('@farmslot/run-bundle');
mock.module('@farmslot/run-bundle', {
  namedExports: {
    ...realBundles,
    runBundleRetentionSettings: () => ({
      policy: { ...realBundles.DEFAULT_RUN_BUNDLE_RETENTION },
      storeRoot: configuredRoot,
    }),
    exportRunsToBundle: async () => {
      wrote.push('export');
      return {};
    },
    importBundle: async () => {
      wrote.push('import');
      return {};
    },
  },
});
const { runBundleExport, runBundleImport } = await import('./run-bundle.js');
const { farmslotRoot } = await import('../projects/repo-root.js');
const { runBundleHome } = await import('../run-completion/retained-artifacts.js');
const { runsDirectory } = await import('../runs/store.js');

const outputPath = path.join(tmpdir(), 'exports/runs.farmslot-bundle');
const importDestinations = () => [
  tmpdir(),
  farmslotRoot(),
  runsDirectory(),
  path.join(runBundleHome(), 'run-bundles'),
];

beforeEach(() => {
  checked.length = 0;
  wrote.length = 0;
  refused = null;
  configuredRoot = undefined;
  rootChecks.length = 0;
});

test('bundle export and import check every destination volume before writing', async () => {
  await runBundleExport({ outputPath });
  assert.deepEqual(checked, [tmpdir(), path.dirname(outputPath)]);
  checked.length = 0;
  await runBundleImport({ bundlePath: '/bundles/runs.farmslot-bundle' });
  assert.deepEqual(checked, importDestinations());
  assert.deepEqual(wrote, ['export', 'import']);
});

test('one destination below the floor refuses the bundle copy and nothing is written', async () => {
  // The temp volume, where export stages media and import extracts, alone is low.
  refused = tmpdir();
  await assert.rejects(runBundleExport({ outputPath }), /under the floor/);
  await assert.rejects(runBundleImport({ bundlePath: '/bundles/b' }), /under the floor/);
  // An external store volume is low while the temp volume is fine.
  refused = runsDirectory();
  await assert.rejects(runBundleImport({ bundlePath: '/bundles/b' }), /under the floor/);
  assert.deepEqual(wrote, []);
});

test('bundle imports guard the configured store instead of the default home path', async () => {
  configuredRoot = path.join(tmpdir(), 'configured-bundle-store');
  await runBundleImport({ bundlePath: '/bundles/b' });
  assert.deepEqual(rootChecks, [configuredRoot]);
  assert.deepEqual(checked, [tmpdir(), farmslotRoot(), runsDirectory(), configuredRoot]);
  wrote.length = 0;
  refused = configuredRoot;
  await assert.rejects(runBundleImport({ bundlePath: '/bundles/b' }), /volume is missing/);
  assert.deepEqual(wrote, []);
});
