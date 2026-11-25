// A run whose task dir another attempt initialized, with the slot copy gone, is refused before
// slot prepare, naming the owner and the fix. A slot copy, its own attempt, or no receipt passes.
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
    loadProjectVars: async (): Promise<realConfig.ProjectVars> => ({
      projectName: 'fixture',
      projectConfig: '/fixture/project.json',
      projectFixturesDir: '/fixture/fixtures',
      projectTemplatesDir: '/fixture/templates',
      projectJson: { name: 'fixture', paths: { artifact_dir: 'temp/tasks' } },
      runtimeDir: '.agent',
      artifactDir: '.task',
    }),
  },
});
mock.module('../core/slot-io.js', {
  namedExports: {
    ...realSlotIo,
    slotFileExists: async (_slot: unknown, file: string) => slotFiles.has(file),
  },
});
mock.module('../runs/store.js', {
  namedExports: {
    ...realStore,
    getRunWithArchived: async (id: string) => knownRuns.get(id) as Run | undefined,
  },
});
const owner: string = './foreign-task-dir.js?foreign-task-dir-test';
const { foreignTaskDirRefusal }: typeof import('./foreign-task-dir.js') = await import(owner);

const SLOT_RECEIPT = `${remoteRepo}/temp/tasks/dev/rerun/artifacts/harness-provenance.json`;
const REMEDY =
  'Re-dispatch with --ticket, or author a fresh task dir: copy TASK.md and CHECKLIST.md to a new folder, leave out artifacts/ and inputs/handoff.json, and update the task paths written inside them.';

/** tasks/dev/rerun with TASK.md and CHECKLIST.md, plus a receipt and a handoff when asked. */
function taskDir(t: TestContext, files: { attemptId?: string; receipt?: boolean }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-task-dir-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'tasks/dev/rerun');
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'TASK.md'), '# Task\n');
  fs.writeFileSync(path.join(dir, 'CHECKLIST.md'), '- [ ] one\n');
  if (files.receipt) fs.writeFileSync(path.join(dir, 'artifacts/harness-provenance.json'), '{}');
  if (files.attemptId)
    fs.writeFileSync(
      path.join(dir, 'inputs/handoff.json'),
      JSON.stringify({ attemptId: files.attemptId }),
    );
  knownRuns.clear();
  slotFiles.clear();
  knownRuns.set('archived-run', { id: 'archived-run', status: 'cancelled' });
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
  const dir = taskDir(t, { attemptId: 'archived-run', receipt: true });
  assert.equal(
    await foreignTaskDirRefusal(run(dir)),
    `Task dir ${dir} was initialized by run archived-run (its handoff names it), and slot slot-1 no longer has its copy. ${REMEDY}`,
  );
});

test('a retained task whose slot copy still holds its receipt is left to verification', async (t) => {
  const dir = taskDir(t, { attemptId: 'archived-run', receipt: true });
  slotFiles.add(SLOT_RECEIPT);
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
});

test('an author-owned attempt is adopted with its slot copy and refused without one', async (t) => {
  const dir = taskDir(t, { attemptId: 'author-owned-attempt', receipt: true });
  assert.match(
    (await foreignTaskDirRefusal(run(dir))) ?? '',
    /was initialized by attempt author-owned-attempt \(its handoff names it\)/,
  );
  slotFiles.add(SLOT_RECEIPT);
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
});

test("a run's own attempt (replay, resume) is not refused", async (t) => {
  const dir = taskDir(t, { attemptId: 'new-run', receipt: true });
  knownRuns.set('new-run', { id: 'new-run', status: 'monitoring' });
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
});

test('a task dir without a receipt is not refused, even with another run in its handoff', async (t) => {
  const dir = taskDir(t, { attemptId: 'archived-run' });
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
});

test('a re-dispatched task file marked pending by write-task is still refused', async (t) => {
  const dir = taskDir(t, { attemptId: 'archived-run', receipt: true });
  const taskFile = path.join(dir, 'TASK.md');
  assert.match(
    (await foreignTaskDirRefusal(
      run(dir, { engineState: { taskInit: { taskFile, status: 'pending' } } } as Partial<Run>),
    )) ?? '',
    /was initialized by run archived-run/,
  );
});

test('the advised fresh task dir is not refused', async (t) => {
  const dir = taskDir(t, { attemptId: 'archived-run', receipt: true });
  const fresh = path.join(path.dirname(dir), 'rerun-2');
  fs.mkdirSync(fresh);
  for (const file of ['TASK.md', 'CHECKLIST.md'])
    fs.copyFileSync(path.join(dir, file), path.join(fresh, file));
  assert.equal(await foreignTaskDirRefusal(run(fresh)), null);
});

test('a malformed handoff fails the check; a missing one is left to task init', async (t) => {
  const dir = taskDir(t, { attemptId: 'archived-run', receipt: true });
  fs.writeFileSync(path.join(dir, 'inputs/handoff.json'), '{not json');
  await assert.rejects(foreignTaskDirRefusal(run(dir)), SyntaxError);
  fs.rmSync(path.join(dir, 'inputs/handoff.json'));
  assert.equal(await foreignTaskDirRefusal(run(dir)), null);
});
