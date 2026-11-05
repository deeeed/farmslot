import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { FleetStatus } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'storage-invalidation-'));
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(root, 'status.json');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
for (const dir of ['pool', 'projects', 'home', 'runs']) await mkdir(path.join(root, dir));
const storage = await import('../core/storage-volume.js');
let available = false;
const repos = ['/Volumes/farmslot-proof-volume/slot', '/Volumes/farmslot-rebound-proof/slot'];
mock.module('../core/storage-volume.js', {
  namedExports: {
    ...storage,
    storageVolumeError: (target: string) =>
      repos.includes(target) && !available
        ? 'Storage unavailable: fixture volume not mounted'
        : undefined,
  },
});
const topologyCallbacks = new Map<string, () => void>();
class MountWatcher extends EventEmitter implements fs.StatWatcher {
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}
mock.method(fs, 'watchFile', (...args: Parameters<typeof fs.watchFile>) => {
  const callback = args.find((arg) => typeof arg === 'function');
  assert(typeof callback === 'function');
  topologyCallbacks.set(String(args[0]), () =>
    Reflect.apply(callback, undefined, [fs.statSync(root), fs.statSync(root)]),
  );
  return new MountWatcher();
});
mock.method(fs, 'unwatchFile', (target: fs.PathLike) => {
  topologyCallbacks.delete(String(target));
});
syncBuiltinESMExports();
const { loadFleetStatus, onStateChange, startFileWatcher } = await import('./state.js');
const { resourceRevisions } = await import('../resources/revisions.js');
test.after(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
});

test(
  'startup-missing and newly configured volume recovery publish scoped slot invalidations',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const slotId = 'local-proof';
    const pool = async (repo: string) =>
      writeFile(
        path.join(root, 'pool/local.json'),
        JSON.stringify({
          schema_version: 2,
          machine: 'local-proof',
          host: 'localhost',
          project: 'proof',
          platform: 'cli',
          os: 'darwin',
          slots: [{ id: slotId, repo, enabled: true }],
        }),
      );
    await pool(repos[0]);
    await writeFile(
      process.env.FARMSLOT_TEST_STATUS_FILE!,
      JSON.stringify({
        checked_at: new Date().toISOString(),
        slots: [
          {
            slot: slotId,
            machine: 'local-proof',
            project: 'proof',
            lifecycle: 'ready',
            phase: null,
            enabled: true,
            dispatchable: true,
            current_run_id: 'retained-owner',
          },
        ],
      }),
    );
    assert.equal((await loadFleetStatus(true)).slots[0].enabled, false);
    const watcher = startFileWatcher();
    t.after(() => watcher.close());
    await watcher.ready;
    assert.equal(topologyCallbacks.size, 1, 'Share one watcher per volume');
    const notifications: FleetStatus[] = [];
    onStateChange((fleet) => notifications.push(fleet));
    for (const repo of repos) {
      available = false;
      await pool(repo);
      await loadFleetStatus(true);
      const keys = [
        { family: 'slot', slotId },
        { family: 'slots', scope: 'farm', project: 'proof' },
        { family: 'slots', scope: 'farm', nodeId: 'local-proof' },
      ] as const;
      const revisions = keys.map((key) => resourceRevisions.revision(key));
      const count = notifications.length;
      available = true;
      assert.equal(topologyCallbacks.size, 1);
      for (const callback of topologyCallbacks.values()) callback();
      assert.equal(notifications.length, count + 1);
      assert.equal(notifications.at(-1)?.slots[0].enabled, true);
      assert.equal(notifications.at(-1)?.slots[0].currentRunId, 'retained-owner');
      for (const [index, key] of keys.entries())
        assert(resourceRevisions.revision(key) > revisions[index]);
    }
  },
);
