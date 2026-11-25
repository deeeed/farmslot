// A run whose task dir another run initialized, with the slot copy gone, is refused before any
// slot work, naming the owner and the fix. Adoption, retained resume and replay still pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

import type { Run } from '@farmslot/protocol';

import * as realConfig from '../core/config.js';
import * as realSlotIo from '../core/slot-io.js';
import * as realStore from '../runs/store.js';

const knownRuns = new Map<string, Partial<Run>>();
const slotFiles = new Set<string>();
const remoteRepo = '/slot/checkout';
mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => ({ slotId: 'slot-1', remoteRepo }) as realConfig.SlotVars,
    loadProjectVars: async () =>
      ({ projectJson: { name: 'fixture', task_dir: 'temp/tasks' } }) as realConfig.ProjectVars,
  },
});
mock.module('../core/slot-io.js', {
  namedExports: { ...realSlotIo, slotFileExists: async (_slot: unknown, file: string) => slotFiles.has(file) },
});
mock.module('../runs/store.js', {
  namedExports: { ...realStore, getRunWithArchived: async (id: string) => knownRuns.get(id) as Run | undefined },
});
const owner: string = './foreign-task-dir.js?foreign-task-dir-test';
const { foreignTaskDirRefusal }: typeof import('./foreign-task-dir.js') = await import(owner);

const SLOT_RECEIPT = `${remoteRepo}/temp/tasks/dev/rerun/artifacts/harness-provenance.json`;

function taskDir(t: TestContext, attemptId: string | null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-task-dir-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'tasks/dev/rerun');
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'TASK.md'), '# Task\n');
  if (attemptId !== null) {
    fs.writeFileSync(path.join(dir, 'artifacts/harness-provenance.json'), '{}');
    fs.writeFileSync(path.join(dir, 'inputs/handoff.json'), JSON.stringify({ attemptId }));
  }
  knownRuns.clear();
  slotFiles.clear();
  return dir;
}

function run(dir: string, overrides: Partial<Run> = {}): Run {
  return {
    id: 'new-run',
    slotId: 'slot-1',
    project: 'fixture',
    taskFile: path.join(dir, 'TASK.md'),
    engineState: {},
    ...overrides,
  } as Run;
}

test('a task dir another run initialized, with its slot copy gone, is refused naming that run', async (t) => {
  const dir = taskDir(t, 'archived-run');
  knownRuns.set('archived-run', { id: 'archived-run', status: 'cancelled' });
  assert.equal(
    await foreignTaskDirRefusal(run(dir)),
    `Task dir ${dir} was initialized by run archived-run; author a fresh task dir (copy TASK.md to a new folder) or re-dispatch with --ticket.`,
  );
});

test('a retained task whose slot copy still holds its receipt is left to verification', async (t) => {
  const dir = taskDir(t, 'archived-run');
  knownRuns.set('archived-run', { id: 'archived-run', status: 'cancelled' });
  slotFiles.add(SLOT_RECEIPT);
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
});

test('an authored task adopted under its own attempt is not refused, with or without a slot copy', async (t) => {
  const dir = taskDir(t, 'author-owned-attempt');
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
  slotFiles.add(SLOT_RECEIPT);
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
});

test("a run's own attempt (replay, resume) is not refused", async (t) => {
  const dir = taskDir(t, 'new-run');
  knownRuns.set('new-run', { id: 'new-run', status: 'running' });
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
});

test('a task dir without a receipt, or one this run is writing, is not refused', async (t) => {
  const bare = taskDir(t, null);
  assert.equal(await foreignTaskDirRefusal(run(bare)), null);
  const dir = taskDir(t, 'archived-run');
  knownRuns.set('archived-run', { id: 'archived-run', status: 'cancelled' });
  const taskFile = path.join(dir, 'TASK.md');
  assert.equal(
    await foreignTaskDirRefusal(
      run(dir, { engineState: { taskInit: { taskFile, status: 'pending' } } } as Partial<Run>),
    ),
    null,
  );
});

test('a malformed or missing handoff is left to the existing initialization checks', async (t) => {
  const dir = taskDir(t, 'archived-run');
  knownRuns.set('archived-run', { id: 'archived-run', status: 'cancelled' });
  fs.writeFileSync(path.join(dir, 'inputs/handoff.json'), '{not json');
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
  fs.rmSync(path.join(dir, 'inputs/handoff.json'));
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
});
