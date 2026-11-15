import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runReplayStep } from '../methods/run/replay-step.js';
import { makeRun } from '../methods/run/test-fixtures.js';
import {
  reclaimReviewWorkspaceStorage,
  useReviewWorkspaceStorage,
} from '../review-workspaces/storage-use.js';
import { hasTaskAdmissions, withTaskAdmission } from '../runs/store.js';
import { readTaskPins, retiredTaskPinsOf, sweepTaskPins } from '../runs/task-pins.cjs';

import {
  NODE_PIN_RETENTION_DEPS,
  nodeTaskPinRetentionPass,
  taskPinProtection,
} from './node-task-pins.js';

const now = Date.parse('2026-11-16T00:00:00Z');
const ageMs = 86400000;
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'node-task-pins-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'pins');
  await mkdir(root);
  async function pin(name: string, taskDir = path.join(home, 'tasks', name)) {
    await mkdir(path.join(root, name));
    const file = path.join(root, name, 'provenance.json');
    await writeFile(file, JSON.stringify({ taskDir }));
    await writeFile(path.join(root, name, 'input'), 'immutable');
    await utimes(file, new Date(now - 2 * ageMs), new Date(now - 2 * ageMs));
    return taskDir;
  }
  return { home, root, pin };
}
const protection = { taskDirs: [], taskNames: [], pinIds: [] };

test('node-local sweep removes an old orphan missed by the gateway pin root', async (t) => {
  const f = await fixture(t);
  await f.pin('orphan');
  const result = await sweepTaskPins({ root: f.root, now, ageMs, protection });
  assert.deepEqual(result.removed, ['orphan']);
  assert.equal(await readFile(path.join(f.root, '.retention-cursor'), 'utf8'), 'orphan');
  assert.deepEqual(await readTaskPins(f.root), []);
});

test('existing task, active/parked missing-task pins, bad provenance and young pins survive', async (t) => {
  const f = await fixture(t);
  const present = await f.pin('present');
  await mkdir(present, { recursive: true });
  const active = await f.pin('active');
  await f.pin('parked');
  await f.pin('broken');
  await writeFile(path.join(f.root, 'broken/provenance.json'), '{');
  await f.pin('young');
  await utimes(path.join(f.root, 'young/provenance.json'), new Date(now), new Date(now));
  const result = await sweepTaskPins({
    root: f.root,
    now,
    ageMs,
    protection: { taskDirs: [active], taskNames: [], pinIds: ['parked'] },
  });
  assert.deepEqual(result.removed, []);
  assert.equal((await readdir(f.root)).filter((n) => !n.startsWith('.retention')).length, 5);
});

test('task or ownership appearing before staging preserves the pin', async (t) => {
  const f = await fixture(t);
  const task = await f.pin('orphan');
  const result = await sweepTaskPins(
    { root: f.root, now, ageMs, protection },
    {
      beforeStage: () => mkdir(task, { recursive: true }).then(() => undefined),
    },
  );
  assert.deepEqual(result.removed, []);
  assert.equal(await readFile(path.join(f.root, 'orphan/input'), 'utf8'), 'immutable');
  await rm(task, { recursive: true });
  let owned = false;
  const held = await sweepTaskPins(
    { root: f.root, now, ageMs, protection },
    {
      beforeStage: async () => {
        owned = true;
      },
      protection: () => ({ taskDirs: [], taskNames: [], pinIds: owned ? ['orphan'] : [] }),
    },
  );
  assert.deepEqual(held.removed, []);
});

test('symlinked pins and unavailable task volumes are kept', async (t) => {
  const f = await fixture(t);
  const elsewhere = path.join(f.home, 'foreign');
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, 'input'), 'keep');
  await symlink(elsewhere, path.join(f.root, 'linked'));
  await f.pin('unmounted', '/Volumes/farmslot-missing-volume/tasks/task');
  const result = await sweepTaskPins({ root: f.root, now, ageMs, protection });
  assert.deepEqual(result.removed, []);
  assert.equal(await readFile(path.join(elsewhere, 'input'), 'utf8'), 'keep');
});

test('32 inspected and 8 removed per pass, rotating beyond protected prefix', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 41; i++) await f.pin(String(i).padStart(2, '0'));
  const kept = Array.from({ length: 32 }, (_, i) => String(i).padStart(2, '0'));
  const input = { root: f.root, now, ageMs, protection: { ...protection, pinIds: kept } };
  const first = await sweepTaskPins(input);
  assert.equal(first.inspected, 32);
  assert.deepEqual(first.removed, []);
  const second = await sweepTaskPins(input);
  assert.equal(second.inspected, 32);
  assert.equal(second.removed.length, 8);
  assert.ok(second.removed.every((id) => Number(id) >= 32));
});

test('interrupted staging retains the pin and can be restored', async (t) => {
  const f = await fixture(t);
  await f.pin('orphan');
  await assert.rejects(
    sweepTaskPins(
      { root: f.root, now, ageMs, protection },
      {
        afterStage: () => {
          throw new Error('power loss');
        },
      },
    ),
    /power loss/,
  );
  const stage = (await readdir(f.root)).find((n) => n.startsWith('.retention-stage-'));
  assert.ok(stage);
  assert.equal(await readFile(path.join(f.root, stage, 'orphan/input'), 'utf8'), 'immutable');
  const next = await sweepTaskPins({
    root: f.root,
    now,
    ageMs,
    protection: { ...protection, pinIds: ['orphan'] },
  });
  assert.deepEqual(next.removed, []);
  assert.equal(await readFile(path.join(f.root, 'orphan/input'), 'utf8'), 'immutable');
});

test('the existing retention predicate still keeps admission and pending task directories', async (t) => {
  const f = await fixture(t);
  const task = await f.pin('held');
  const entries = await readTaskPins(f.root);
  assert.deepEqual(
    await retiredTaskPinsOf(entries, new Set(), { now, ageMs }, (p) => p === task),
    [],
  );
});

test('gateway sweep reaches node roots, stages under fence and purges outside it', async (t) => {
  const { stageTaskPins, purgeTaskPins } = await import('../runs/task-pins.cjs');
  const f = await fixture(t);
  await f.pin('remote-orphan');
  let fenced = false;
  const operations: string[] = [];
  await nodeTaskPinRetentionPass(now, ageMs, {
    targets: async () => [{ machine: 'fixture-node', host: 'fixture', sshUser: '', root: f.root }],
    runs: async () => [],
    fence: async (operation) => {
      fenced = true;
      try {
        return await operation();
      } finally {
        fenced = false;
      }
    },
    execute: async (_target, payload) => {
      assert.ok('op' in payload);
      operations.push(String(payload.op));
      if (payload.op === 'stage') {
        assert.equal(fenced, true);
        return stageTaskPins({ root: f.root, now, ageMs, protection });
      }
      assert.equal(fenced, false);
      return purgeTaskPins(f.root, payload.result);
    },
  });
  assert.deepEqual(operations, ['stage', 'purge']);
  assert.deepEqual(await readTaskPins(f.root), []);
});

test('an in-flight task admission excludes node staging, including taskless admission', async () => {
  let commands = 0;
  for (const taskFile of [undefined, '/owned/task/TASK.md']) {
    await useReviewWorkspaceStorage(() =>
      withTaskAdmission(taskFile, () =>
        nodeTaskPinRetentionPass(now, ageMs, {
          targets: async () => [
            { machine: 'fixture-node', host: 'fixture', sshUser: '', root: '/unused' },
          ],
          runs: async () => [],
          execute: async () => {
            commands++;
            return null;
          },
          fence: async (operation) =>
            hasTaskAdmissions() ? [] : reclaimReviewWorkspaceStorage(operation),
        }),
      ),
    );
  }
  assert.equal(commands, 0);
});

test('the shipped node program removes an orphan through the real command boundary', async (t) => {
  const f = await fixture(t);
  await f.pin('real-command-orphan');
  await nodeTaskPinRetentionPass(now, ageMs, {
    ...NODE_PIN_RETENTION_DEPS,
    targets: async () => [{ machine: 'local', host: 'localhost', sshUser: '', root: f.root }],
    runs: async () => [],
  });
  assert.deepEqual(await readTaskPins(f.root), []);
});

test('authoritative run task identities protect active and publish-gated pins across node paths', async (t) => {
  const f = await fixture(t);
  await f.pin('active-pin', path.join(f.home, 'remote/tasks/active'));
  await f.pin('gated-pin', path.join(f.home, 'remote/tasks/gated'));
  await f.pin('orphan');
  const active = makeRun({ taskFile: '/gateway/tasks/active/TASK.md' });
  const gated = makeRun({
    id: 'gated-run',
    status: 'done',
    taskFile: '/gateway/tasks/gated/TASK.md',
    decisions: [
      {
        id: 'publish',
        type: 'engine_human_gate',
        title: 'Publish',
        description: 'Publish retained work',
        actions: [],
        createdAt: new Date(now).toISOString(),
      },
    ],
  });
  const result = await sweepTaskPins({
    root: f.root,
    now,
    ageMs,
    protection: taskPinProtection([active, gated]),
  });
  assert.deepEqual(result.removed, ['orphan']);
  assert.equal((await readTaskPins(f.root)).length, 2);
});

test('terminal replay waits until the node pin staging fence is released', async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleanup = reclaimReviewWorkspaceStorage(async () => {
    entered();
    await held;
    return [];
  });
  await ready;
  let settled = false;
  const replay = runReplayStep(
    { runId: 'missing-pin-sweep-fixture', stepName: 'prepare' },
    () => {},
  ).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await new Promise<void>(setImmediate);
    assert.equal(settled, false);
  } finally {
    release();
    await cleanup;
    await replay;
  }
  assert.equal(settled, true);
});
