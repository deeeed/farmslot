import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

// A layout-2 farm whose data root sits on another volume than its home.
const root = mkdtempSync(path.join(tmpdir(), 'run-bundle-layout2-'));
const home = path.join(root, 'home');
const dataRoot = path.join(root, 'data-volume');
mkdirSync(path.join(home, 'config'), { recursive: true });
writeFileSync(path.join(home, 'config', 'instance.json'), JSON.stringify({ layout: 2, dataRoot }));
process.env.FARMSLOT_HOME = home;
after(() => rmSync(root, { recursive: true, force: true }));

const checked: string[] = [];
const realGuard = await import('../core/heavy-write-room.js');
mock.module('../core/heavy-write-room.js', {
  namedExports: {
    ...realGuard,
    assertHeavyWriteRoom: async (dir: string) => {
      checked.push(dir);
    },
  },
});
const realBundles = await import('@farmslot/run-bundle');
mock.module('@farmslot/run-bundle', {
  namedExports: { ...realBundles, importBundle: async () => ({}) },
});
const { runBundleImport } = await import('./run-bundle.js');

test('a layout-2 import checks free space on the data root that holds the bundle store', async () => {
  await runBundleImport({ bundlePath: '/bundles/runs.farmslot-bundle' });
  assert.ok(checked.includes(path.join(dataRoot, 'run-bundles')), checked.join(', '));
  assert.equal(checked.includes(path.join(home, 'run-bundles')), false);
});
