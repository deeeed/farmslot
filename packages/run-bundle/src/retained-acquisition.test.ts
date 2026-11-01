import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

// Counts the file stats that land inside task dirs, i.e. which admissions walk them.
let taskStats = 0;
let tasksRoot = '';
mock.module('node:fs/promises', {
  namedExports: {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (tasksRoot && String(args[0]).startsWith(tasksRoot)) taskStats++;
      return fs.stat(...args);
    },
  },
});
const { openRunBundleStore, recordRunBundleAcquisition, runBundleAdmissionUsage } =
  await import('./retained.js');

async function farm(t: TestContext, tasks = 'projects/demo/tasks') {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'retained-acquisition-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await openRunBundleStore({
    runsDir: path.join(root, '.runs'),
    home: path.join(root, 'home'),
    create: true,
  });
  tasksRoot = path.join(root, tasks);
  const taskDirs: string[] = [];
  for (let task = 0; task < 4; task++) {
    const taskDir = path.join(tasksRoot, task % 2 ? 'qa' : 'feat', `task-${task}`);
    await fs.mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
    for (let file = 0; file < 5; file++)
      await fs.writeFile(path.join(taskDir, 'artifacts', `${file}.png`), Buffer.alloc(1_000));
    taskDirs.push(taskDir);
  }
  const acquisition = async () => {
    taskStats = 0;
    return (await runBundleAdmissionUsage(store, root)).acquisition;
  };
  const record = (taskDir: string) =>
    path.join(
      store.root,
      'acquisition',
      `${createHash('sha256').update(path.resolve(taskDir)).digest('hex')}.json`,
    );
  return { root, store, taskDirs, acquisition, record };
}

test('admission measures task dirs once, then charges their records without a walk', async (t) => {
  const f = await farm(t);
  assert.equal(await f.acquisition(), 20_000);
  assert.equal(taskStats, 20, 'the first admission measures every task file');
  assert.equal(await f.acquisition(), 20_000);
  assert.equal(taskStats, 0, 'an unchanged task dir is charged its record, not stat-ed');
});

test('a recorded change is charged, an unrecorded one is not rescanned, a removal lowers the charge', async (t) => {
  const f = await farm(t);
  await f.acquisition();
  const changed = f.taskDirs[0]!;
  const removed = f.taskDirs[1]!;
  await fs.writeFile(path.join(changed, 'artifacts/capture.mp4'), Buffer.alloc(5_000));
  assert.equal(await f.acquisition(), 20_000, 'bytes no writer recorded stay unseen');
  await recordRunBundleAcquisition(f.store, changed);
  assert.equal(await f.acquisition(), 25_000);
  assert.equal(taskStats, 0);
  // An eval candidate's task dir sits deeper: its writer re-measures the task dir holding it.
  const candidate = path.join(changed, 'candidates/c1');
  await fs.mkdir(candidate, { recursive: true });
  await fs.writeFile(path.join(candidate, 'first-output.diff'), Buffer.alloc(2_000));
  await recordRunBundleAcquisition(f.store, candidate);
  assert.equal(await f.acquisition(), 27_000);
  await fs.rm(removed, { recursive: true });
  assert.equal(await f.acquisition(), 22_000);
  await assert.rejects(fs.readFile(f.record(removed)), /ENOENT/, 'its record goes with it');
});

test('a task dir without a valid record is measured once and recorded', async (t) => {
  const f = await farm(t);
  await f.acquisition();
  const missing = f.taskDirs[0]!;
  const invalid = f.taskDirs[1]!;
  await fs.rm(f.record(missing));
  await fs.writeFile(f.record(invalid), JSON.stringify({ path: '/elsewhere', bytes: 1 }));
  assert.equal(await f.acquisition(), 20_000);
  assert.equal(taskStats, 10, 'only the two task dirs without a valid record are measured');
  for (const taskDir of [missing, invalid])
    assert.deepEqual(JSON.parse(await fs.readFile(f.record(taskDir), 'utf8')), {
      path: path.resolve(taskDir),
      bytes: 5_000,
    });
  assert.equal(await f.acquisition(), 20_000);
  assert.equal(taskStats, 0);
});

test('a projects dir inside the root sandbox is charged once from its records', async (t) => {
  const f = await farm(t, '.sandbox/electron/projects/demo/tasks');
  const previous = process.env.FARMSLOT_PROJECTS_DIR;
  process.env.FARMSLOT_PROJECTS_DIR = path.join(f.root, '.sandbox/electron/projects');
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_PROJECTS_DIR;
    else process.env.FARMSLOT_PROJECTS_DIR = previous;
  });
  // A mock-mode project keeps its task root directly under the sandbox.
  const mockTask = path.join(f.root, '.sandbox/demo/tasks/qa/mock-task');
  await fs.mkdir(mockTask, { recursive: true });
  await fs.writeFile(path.join(mockTask, 'TASK.md'), Buffer.alloc(3_000));
  tasksRoot = path.join(f.root, '.sandbox');
  assert.equal(await f.acquisition(), 23_000);
  assert.equal(await f.acquisition(), 23_000);
  assert.equal(taskStats, 0);
});
