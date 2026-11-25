import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { TempScrubReceipt } from '@farmslot/protocol';

import '../core/hermetic-git.test-support.js';
import '../core/private-pool.test-support.js';

import type { ProjectVars } from '../core/config.js';

// A real prepare for a new run, on the fixture project shaped like Mobile, Extension and Core:
// task root temp/tasks, runtime dir temp/recipe/runtime, deps stamps in temp/farmslot.
const runsDir = await mkdtemp(path.join(os.tmpdir(), 'prepare-temp-scrub-runs-'));
process.env.FARMSLOT_RUNS_DIR = runsDir;
after(() => rm(runsDir, { recursive: true, force: true }));
const realConfig = await import('../core/config.js');
const mobileShaped = (vars: ProjectVars): ProjectVars => {
  // metamask-mobile-farm's own paths: no task_dir, so the task root comes from artifact_dir.
  const projectJson = {
    ...vars.projectJson,
    paths: { runtime_dir: 'temp/recipe/runtime', artifact_dir: 'temp/tasks' },
  };
  Reflect.deleteProperty(projectJson, 'task_dir');
  return { ...vars, runtimeDir: 'temp/recipe/runtime', projectJson };
};
mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadProjectVars: async (name: string) => mobileShaped(await realConfig.loadProjectVars(name)),
  },
});
const { needsTmuxSandbox, slotPrepare, stackFixture } =
  await import('./stack-base-prepare.test-support.js');
const runs = await import('../runs/store.js');
const execFileAsync = promisify(execFile);

test(
  'a real prepare for a new run on a mobile-shaped slot keeps temp/farmslot and clears the rest',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo } = await stackFixture(t, 'temp-scrub', 48860);
    // temp/ is ignored in every pack checkout.
    await writeFile(path.join(slotRepo, '.git/info/exclude'), 'temp/\n');
    const leftovers = [
      'temp/farmslot/deps-setup.stamp',
      'temp/tasks/feat/tat-4752-1123-101010/TASK.md',
      'temp/scratch-tat4752/fix-notes.md',
      'temp/tat4505-trace.json',
    ];
    for (const rel of leftovers) {
      await mkdir(path.dirname(path.join(slotRepo, rel)), { recursive: true });
      await writeFile(path.join(slotRepo, rel), 'answer');
    }
    // A worker's nested clone: deleted outright and named.
    await execFileAsync('git', ['init', '-q', path.join(slotRepo, 'temp/tasks/goal3-clone')]);
    const created = runs.createRun(
      { flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'TAT-4900', slotId },
      { deferBackgroundPersist: true },
    );
    const run = runs.updateRun(created.id, {
      taskFile: '/farm/projects/farmslot-farm/tasks/feat/tat-4900-1125-090000/TASK.md',
    })!;
    t.after(() => runs.updateRun(run.id, { status: 'failed' }));
    const events: unknown[] = [];

    const recorded: TempScrubReceipt[] = [];
    const result = await slotPrepare(
      { slotId, runId: run.id, prepareProfile: 'core' },
      (_event, payload) => events.push(payload),
      undefined,
      { onTempScrubbed: (receipt) => recorded.push(receipt) },
    );

    assert.equal(existsSync(path.join(slotRepo, 'temp/farmslot/deps-setup.stamp')), true);
    for (const rel of leftovers.slice(1))
      assert.equal(existsSync(path.join(slotRepo, rel)), false, rel);
    assert.match(
      JSON.stringify(events),
      /Removed earlier task dir temp\/tasks\/feat\/tat-4752-1123-101010 \(no run record\)/,
    );
    assert.match(JSON.stringify(events), /Deleted nested clone temp\/tasks\/goal3-clone/);
    assert.equal(existsSync(path.join(slotRepo, 'temp/tasks/goal3-clone')), false);
    // Every other entry is named too, not only counted, and the run's step is handed the list.
    assert.match(JSON.stringify(events), /Removed dir temp\/scratch-tat4752/);
    assert.match(JSON.stringify(events), /Removed file temp\/tat4505-trace.json/);
    assert.equal(recorded.length, 1, 'the run step is handed the clear-out once');
    // One step event for the whole clear-out; its lines ride one output chunk.
    const cleanSteps = events.filter(
      (payload) => (payload as { name?: unknown } | null)?.name === 'clean',
    );
    assert.equal(cleanSteps.length, 1, JSON.stringify(cleanSteps));
    const [receipt] = recorded;
    assert.ok(receipt);
    assert.deepEqual(result.tempScrub, receipt);
    const removed = receipt.removed.map((entry) => `${entry.type} ${entry.path}`);
    for (const expected of [
      'checkout temp/tasks/goal3-clone',
      'task-dir temp/tasks/feat/tat-4752-1123-101010',
      'entry temp/scratch-tat4752',
      'entry temp/tat4505-trace.json',
    ])
      assert.ok(removed.includes(expected), `${expected} in ${JSON.stringify(removed)}`);
    assert.equal(receipt.removedCount, receipt.removed.length);
    assert.equal(receipt.refusedCount, 0);
  },
);

test(
  'a refused clear-out hands the run step its record before prepare fails',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo } = await stackFixture(t, 'temp-scrub-refused', 48870);
    await writeFile(path.join(slotRepo, '.git/info/exclude'), 'temp/\n');
    // temp/ must be a plain directory: a symlink is refused and nothing under it is touched.
    const outside = await mkdtemp(path.join(os.tmpdir(), 'prepare-temp-scrub-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, 'scratch.json'), '{}');
    await symlink(outside, path.join(slotRepo, 'temp'));
    const created = runs.createRun(
      { flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'TAT-4901', slotId },
      { deferBackgroundPersist: true },
    );
    const run = runs.updateRun(created.id, {
      taskFile: '/farm/projects/farmslot-farm/tasks/feat/tat-4901-1125-090000/TASK.md',
    })!;
    t.after(() => runs.updateRun(run.id, { status: 'failed' }));
    const recorded: TempScrubReceipt[] = [];

    await assert.rejects(
      slotPrepare({ slotId, runId: run.id, prepareProfile: 'core' }, () => {}, undefined, {
        onTempScrubbed: (receipt) => recorded.push(receipt),
      }),
      /temp\/ still holds another run's files: temp \(temp\/ is not a plain directory/,
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.refusedCount, 1);
    assert.equal(recorded[0]?.refused[0]?.path, 'temp');
    assert.equal(recorded[0]?.removedCount, 0);
    assert.equal(existsSync(path.join(outside, 'scratch.json')), true);
  },
);
