import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'storage-availability-'));
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(root, 'status.json');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
const missing = `/Volumes/farmslot-missing-proof-${process.pid}`;
process.env.FARMSLOT_RUN_ARCHIVE_ROOT = path.join(missing, 'archive');
for (const dir of ['pool', 'projects', 'home', 'runs']) await mkdir(path.join(root, dir));
const { loadFleetStatus } = await import('./state.js');
const { gatewayDoctor } = await import('../methods/gateway-doctor.js');
const { validateSlotForDispatch } = await import('../methods/dispatch/slot-scoring.js');
test.after(() => rm(root, { recursive: true, force: true }));

async function pool(localRepo: string): Promise<void> {
  for (const [machine, host, repo] of [
    ['local-proof', 'localhost', localRepo],
    ['remote-proof', 'remote.invalid', missing],
  ])
    await writeFile(
      path.join(root, 'pool', machine + '.json'),
      JSON.stringify({
        schema_version: 2,
        machine,
        host,
        project: 'proof',
        platform: 'cli',
        os: 'darwin',
        slots: [{ id: machine, repo, enabled: true }],
      }),
    );
}

test(
  'missing local storage blocks every dispatch mode, preserves ownership and alerts without disabling remote slots',
  { skip: process.platform !== 'darwin' },
  async () => {
    await pool(missing);
    await writeFile(
      process.env.FARMSLOT_TEST_STATUS_FILE!,
      JSON.stringify({
        checked_at: new Date().toISOString(),
        slots: ['local-proof', 'remote-proof'].map((slot) => ({
          slot,
          machine: slot,
          project: 'proof',
          lifecycle: 'ready',
          phase: null,
          enabled: true,
          dispatchable: true,
          current_run_id: 'retained-owner',
          task_file: `${missing}/TASK.md`,
        })),
      }),
    );
    const fleet = await loadFleetStatus(true);
    const local = fleet.slots.find((slot) => slot.slot === 'local-proof');
    const remote = fleet.slots.find((slot) => slot.slot === 'remote-proof');
    assert(local && remote);
    assert.equal(local.enabled, false);
    assert.equal(local.dispatchable, false);
    assert.equal(local.currentRunId, 'retained-owner');
    assert.equal(local.taskFile, `${missing}/TASK.md`);
    assert.match(local.repoBlocker!, /Storage unavailable.*not mounted/);
    for (const skipPrepare of [true, false])
      assert.match(
        validateSlotForDispatch(local, fleet.slots, { skipPrepare, explicitSlot: true })!,
        /Storage unavailable/,
      );
    assert.equal(remote.enabled, true);
    const doctor = await gatewayDoctor({ sectionId: 'workspace' });
    const storage = doctor.sections[0].checks.find((check) => check.id === 'storage-volumes');
    assert(storage && !storage.ok);
    assert.match(storage.detail, /archive/);
    assert.match(storage.detail, /local-proof/);
    assert.doesNotMatch(storage.detail, /remote-proof/);
    await pool(root);
    const restored = (await loadFleetStatus(true)).slots.find(
      (slot) => slot.slot === 'local-proof',
    );
    assert(restored);
    assert.equal(restored.enabled, true);
    assert.equal(restored.lifecycle, 'ready');
    assert.equal(restored.currentRunId, 'retained-owner');
  },
);
