import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { Run, RunOutput } from '@farmslot/protocol';

// The scrub and the parking run for real against a temp slot repo; only the transport, the
// slot row and the bundle store are faked: `<bundles>/<runId>/manifest.json` and
// `<bundles>/<runId>/tasks/t/`.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'temp-scrub-run-')));
for (const dir of ['runs', 'home', 'pool', 'bundles']) mkdirSync(path.join(root, dir));
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
after(() => rmSync(root, { recursive: true, force: true }));

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const onSlot = async (_vars: unknown, cmd: string) => {
  const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env: gitEnv, timeout: 60_000 });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
};
let slotRow: Record<string, unknown> = { lifecycle: 'ready' };
const realCore = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    execOnSlot: onSlot,
    readSlotRow: async () => slotRow,
    updateSlotStatusIf: async () => true,
  },
});
const realExec = await import('../../core/exec.js');
mock.module('../../core/exec.js', { namedExports: { ...realExec, execOnSlot: onSlot } });
const realState = await import('../../core/state.js');
mock.module('../../core/state.js', {
  namedExports: { ...realState, readSlotRow: async () => slotRow, updateSlotStatusIf: async () => true },
});
const realRetained = await import('../../run-completion/retained-artifacts.js');
mock.module('../../run-completion/retained-artifacts.js', {
  namedExports: {
    ...realRetained,
    retainedRunTaskDirectory: async (run: Run) => path.join(root, 'bundles', run.id, 'tasks/t'),
  },
});

const runs = await import('../../runs/store.js');
const { makeVars } = await import('../../runners/test-fixtures.js');
const { scrubTempForRun, shouldScrubTempForRun, taskBundleCheck, tempStatePaths } =
  await import('./temp-scrub.js');

const SLOT_ID = 'macpro-mme-1';
const repo = path.join(root, 'slot');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim();
mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
writeFileSync(path.join(repo, '.gitignore'), 'temp/\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'base');

const vars = makeVars({ slotId: SLOT_ID, remoteRepo: repo });
const terminalProject = {
  task_dir: 'temp/tasks',
  paths: { runtime_dir: 'temp/farmslot' },
  resources: {
    'dev-server': {
      type: 'dev-server',
      label: 'Dev server',
      watch: { type: 'pid-file', path: '{{runtime_dir}}/next-dev.pid' },
    },
    browser: {
      type: 'browser',
      label: 'Browser',
      watch: { type: 'pid-file', path: 'temp/recipe/runtime/terminal/browser.pid' },
    },
  },
};
// Mobile, extension and core: the runtime dir is temp/recipe/runtime, deps stamps sit in temp/farmslot.
const mobileProject = { task_dir: 'temp/tasks', paths: { runtime_dir: 'temp/recipe/runtime' } };
const orchestratorTask = (flow: string, name: string) =>
  `/farm/projects/va-mmcx-terminal-farm/tasks/${flow}/${name}/TASK.md`;
const write = (rel: string, body = 'answer') => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), body);
};
const present = (rel: string) => existsSync(path.join(repo, rel));
const captured: RunOutput = {
  capturedAt: '2026-11-25T00:00:00.000Z',
  workerFinished: true,
  artifactManifest: [{ path: 'artifacts/fix.diff', purpose: 'patch' }],
  manifestDigest: 'sha256:m',
  artifactBundle: {
    storeId: 'local',
    bundleDigest: 'sha256:b',
    taskKey: 't',
    manifestDigest: 'sha256:m',
  },
};

function slotRun(ticket: string, flow: string, name: string, patch: Partial<Run> = {}) {
  const run = runs.createRun(
    { flowType: 'dev', project: 'fixture', ticketOrPr: ticket, slotId: SLOT_ID },
    { deferBackgroundPersist: true },
  );
  return runs.updateRun(run.id, { taskFile: orchestratorTask(flow, name), ...patch })!;
}
const finish = (...done: Run[]) => {
  for (const run of done) runs.updateRun(run.id, { status: 'failed' });
};
function bundleHas(run: Run, files: string[], taskRelativePath?: string) {
  const dir = path.join(root, 'bundles', run.id);
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(dir, 'tasks/t', rel)), { recursive: true });
    writeFileSync(path.join(dir, 'tasks/t', rel), 'x');
  }
  const taskFile = run.taskFile ?? '';
  const folder = path.basename(path.dirname(path.dirname(taskFile)));
  const name = path.basename(path.dirname(taskFile));
  const record: { originalRunId: string; taskRelativePath: string } = {
    originalRunId: run.id,
    taskRelativePath: taskRelativePath ?? `projects/va-mmcx-terminal-farm/tasks/${folder}/${name}`,
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runs: [record] }));
}
/** A park that freed the slot at an operator wait (ADR-054). */
function freedPark(runId: string): Run['park'] {
  return {
    version: 1,
    operationId: `park-${runId}`,
    previewId: `preview-${runId}`,
    runId,
    generation: 1,
    machine: 'macpro',
    slotId: SLOT_ID,
    mode: 'release',
    phase: 'parked',
    slotDisposition: 'freed',
    slotFreedAt: '2026-11-25T07:30:10.000Z',
    prePauseStatus: 'human-gating',
    prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
    resourceManifest: { capturedAt: '2026-11-25T07:30:00.000Z', resources: [], capabilityLeases: [] },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped', resources: [] },
    createdAt: '2026-11-25T07:30:00.000Z',
    updatedAt: '2026-11-25T07:30:10.000Z',
  };
}
const parkedRefs = () =>
  git(repo, 'for-each-ref', '--format=%(refname)', 'refs/farmslot/parked/').split('\n').filter(Boolean);

test('farm state: temp/farmslot always, the runtime dir and watched resource dirs', () => {
  assert.deepEqual(tempStatePaths(terminalProject), [
    'temp/farmslot',
    'temp/recipe/harness',
    'temp/recipe/runtime/terminal',
    'temp/.agent/preflight.pid',
    'temp/.metadata_never_index',
  ]);
  assert.deepEqual(tempStatePaths(mobileProject), [
    'temp/farmslot',
    'temp/recipe/runtime',
    'temp/recipe/harness',
    'temp/.agent/preflight.pid',
    'temp/.metadata_never_index',
  ]);
});

test('a new run on a mobile-shaped slot clears temp/ but keeps temp/farmslot and its own dirs', async () => {
  for (const rel of [
    'temp/farmslot/deps-setup.stamp',
    'temp/farmslot/ci-parity/run.sh',
    'temp/recipe/runtime/metro.pid',
    'temp/tasks/feat/tat-4752-1123-101010/TASK.md',
    'temp/tasks/fix/tat-4591-1111-173307/TASK.md',
    'temp/tasks/feat/parent-1124-080000/TASK.md',
    'temp/tasks/feat/new-1125-090000/TASK.md',
    'temp/scratch-tat4752/fix-notes.md',
    'temp/tat4505-trace.json',
  ])
    write(rel);
  const bundled = slotRun('TAT-4752', 'feat', 'tat-4752-1123-101010', {
    status: 'done',
    output: captured,
  });
  bundleHas(bundled, ['TASK.md', 'artifacts/fix.diff']);
  const unbundled = slotRun('TAT-4591', 'fix', 'tat-4591-1111-173307', { status: 'failed' });
  const parent = slotRun('TAT-4800', 'feat', 'parent-1124-080000', { status: 'done' });
  const child = slotRun('TAT-4802', 'feat', 'new-1125-090000', { parentRunId: parent.id });

  const outcome = await scrubTempForRun(vars, mobileProject, child);

  if (!outcome) return assert.fail('the temp/tasks layout is scrubbed');
  assert.deepEqual(outcome.refused, []);
  for (const kept of [
    'temp/farmslot/deps-setup.stamp',
    'temp/farmslot/ci-parity/run.sh',
    'temp/recipe/runtime/metro.pid',
    'temp/tasks/feat/parent-1124-080000/TASK.md',
    'temp/tasks/feat/new-1125-090000/TASK.md',
  ])
    assert.equal(present(kept), true, kept);
  for (const gone of [
    'temp/tasks/feat/tat-4752-1123-101010',
    'temp/tasks/fix',
    'temp/scratch-tat4752',
    'temp/tat4505-trace.json',
  ])
    assert.equal(present(gone), false, gone);
  assert.deepEqual(
    outcome.taskDirs.map(({ runId, bundle }) => [runId, bundle]).sort(),
    [
      [bundled.id, 'in its bundle'],
      [unbundled.id, 'NOT in a bundle (no final bundle)'],
    ].sort(),
  );
  finish(child);
});

test('another live run on the slot stops the clear-out; a queued pin or a parked run does not', async () => {
  write('temp/tasks/feat/live-1125-080000/TASK.md');
  write('temp/tasks/feat/parked-1125-070000/TASK.md');
  write('temp/scratch-live/notes.md');
  const live = slotRun('TAT-4900', 'feat', 'live-1125-080000', { status: 'monitoring' });
  const fresh = slotRun('TAT-4901', 'feat', 'fresh-1125-090000');
  await assert.rejects(
    scrubTempForRun(vars, terminalProject, fresh),
    /still has live run .*Finish, park or release that run/,
  );
  assert.equal(present('temp/scratch-live/notes.md'), true);
  finish(live);

  // `createRun` records a requested --slot on a queued run; a parked run keeps its slot id.
  const queued = slotRun('TAT-4903', 'feat', 'queued-1125-100000', { status: 'slot-finding' });
  const parked = slotRun('TAT-4904', 'feat', 'parked-1125-070000', { status: 'human-gating' });
  runs.updateRun(parked.id, { park: freedPark(parked.id) });
  const outcome = await scrubTempForRun(vars, terminalProject, fresh);
  assert.deepEqual(outcome?.refused, []);
  assert.equal(present('temp/tasks/feat/parked-1125-070000/TASK.md'), true, "the parked run's dir");
  assert.equal(present('temp/tasks/feat/live-1125-080000'), false);
  assert.equal(present('temp/scratch-live'), false);
  finish(fresh, queued, parked);
});

test("a checkout directly under temp/tasks has its dirty work parked as a ref, then it's gone", async () => {
  const clone = path.join(repo, 'temp/tasks/goal3-clone');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(clone, 'fix.ts'), 'committed fix\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'unpushed fix');
  git(clone, 'branch', 'side');
  mkdirSync(path.join(clone, 'src'));
  writeFileSync(path.join(clone, 'src/answer.ts'), 'the held-out answer\n');
  const linked = path.join(repo, 'temp/tasks/feat/wt-1125-070000/wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', linked);
  writeFileSync(path.join(linked, 'draft.md'), 'linked worktree draft\n');
  const run = slotRun('TAT-5200', 'feat', 'new-1125-110000');
  const before = new Set(parkedRefs());

  const outcome = await scrubTempForRun(vars, terminalProject, run);

  assert.deepEqual(outcome?.refused, []);
  assert.deepEqual(outcome?.parked.map((entry) => entry.path).sort(), [
    'temp/tasks/feat/wt-1125-070000/wt',
    'temp/tasks/goal3-clone',
  ]);
  assert.equal(present('temp/tasks/goal3-clone'), false, 'the checkout is deleted');
  assert.equal(present('temp/tasks/feat/wt-1125-070000'), false);
  assert.doesNotMatch(git(repo, 'worktree', 'list'), /wt-1125-070000/, 'no stale worktree admin');
  const added = parkedRefs().filter((ref) => !before.has(ref));
  const trees = added.map((ref) => git(repo, 'ls-tree', '-r', '--name-only', ref)).join('\n');
  assert.match(trees, /^src\/answer\.ts$/m, 'the dirty file is in a parked ref');
  assert.match(trees, /^draft\.md$/m, "the linked worktree's draft too");
  assert.ok(added.length >= 3, 'HEAD with its dirty work, the side branch and the worktree');
  finish(run);
});

test('a checkout that cannot be parked fails the clear-out by name and stays', async () => {
  const unborn = path.join(repo, 'temp/scratch-x/new');
  mkdirSync(unborn, { recursive: true });
  git(unborn, 'init', '-q');
  writeFileSync(path.join(unborn, 'work.md'), 'uncommitted\n');
  write('temp/other-leftover.json');
  const run = slotRun('TAT-5300', 'feat', 'new-1125-120000');
  await assert.rejects(
    scrubTempForRun(vars, terminalProject, run),
    /Could not park nested checkout temp\/scratch-x\/new before clearing temp\/: it has no commit/,
  );
  assert.equal(present('temp/scratch-x/new/work.md'), true);
  assert.equal(present('temp/other-leftover.json'), true, 'nothing is deleted before parking');
  rmSync(path.join(repo, 'temp/scratch-x'), { recursive: true });
  finish(run);
});

test('a bundle confirms a task only for this task, with TASK.md and every artifact', async () => {
  const run = slotRun('TAT-5000', 'feat', 'tat-5000', { status: 'done', output: captured });
  bundleHas(run, ['TASK.md']);
  assert.deepEqual(await taskBundleCheck(runs.getRun(run.id)!), {
    confirmed: false,
    reason: 'bundle lacks artifacts/fix.diff',
  });
  bundleHas(run, ['artifacts/fix.diff'], 'projects/va-mmcx-terminal-farm/tasks/feat/other-task');
  assert.deepEqual(await taskBundleCheck(runs.getRun(run.id)!), {
    confirmed: false,
    reason: 'bundle record names another task',
  });
  bundleHas(run, [], 'projects/va-mmcx-terminal-farm/tasks/xfeat/tat-5000');
  assert.equal(
    (await taskBundleCheck(runs.getRun(run.id)!)).confirmed,
    false,
    'the folder matches at a path boundary only',
  );
  bundleHas(run, []);
  assert.equal((await taskBundleCheck(runs.getRun(run.id)!)).confirmed, true);
  runs.updateRun(run.id, { output: { ...captured, retentionMissingData: ['media'] } });
  assert.equal((await taskBundleCheck(runs.getRun(run.id)!)).confirmed, false);
});

test('a warm handoff, a replay or a resumed task keeps temp/; a failed handoff does not', () => {
  const fresh = slotRun('TAT-5100', 'feat', 'fresh');
  assert.equal(shouldScrubTempForRun(fresh), true);
  assert.equal(
    shouldScrubTempForRun({ ...fresh, engineState: { flags: { warmSessionReuse: true } } }),
    false,
  );
  assert.equal(
    shouldScrubTempForRun({
      ...fresh,
      engineState: { flags: { warmSessionReuse: true, warmHandoffSucceeded: false } },
    }),
    true,
    'a handoff that fell back to a fresh dispatch is a new run',
  );
  assert.equal(
    shouldScrubTempForRun({
      ...fresh,
      engineState: { taskInit: { taskFile: fresh.taskFile!, status: 'initialized' } },
    }),
    false,
  );
  assert.equal(
    shouldScrubTempForRun({
      ...fresh,
      engineState: {
        taskInit: { taskFile: orchestratorTask('feat', 'old'), status: 'initialized' },
      },
    }),
    true,
    'an initialized earlier task is not this one',
  );
  assert.equal(
    shouldScrubTempForRun({
      ...fresh,
      steps: [...fresh.steps, { name: 'dispatch', status: 'done' }],
    }),
    false,
  );
  assert.equal(shouldScrubTempForRun(undefined), false);
  finish(fresh);
});
