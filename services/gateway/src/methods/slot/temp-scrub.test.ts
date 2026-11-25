import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { Run, RunOutput } from '@farmslot/protocol';

// The scrub runs for real against a temp slot repo; only the transport, the slot row and the
// bundle store are faked: `<bundles>/<runId>/manifest.json` and
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
const slotRow: Record<string, unknown> = { lifecycle: 'ready' };
const realCore = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: { ...realCore, execOnSlot: onSlot, readSlotRow: async () => slotRow },
});
const realExec = await import('../../core/exec.js');
mock.module('../../core/exec.js', { namedExports: { ...realExec, execOnSlot: onSlot } });
const realRetained = await import('../../run-completion/retained-artifacts.js');
mock.module('../../run-completion/retained-artifacts.js', {
  namedExports: {
    ...realRetained,
    retainedRunTaskDirectory: async (run: Run) => path.join(root, 'bundles', run.id, 'tasks/t'),
  },
});

const runs = await import('../../runs/store.js');
const { makeVars } = await import('../../runners/test-fixtures.js');
const {
  scrubTempForRun,
  shouldScrubTempForRun,
  taskBundleCheck,
  TEMP_SCRUB_LISTED,
  tempScrubLines,
  tempScrubReceipt,
  tempScrubSummary,
  tempStatePaths,
} = await import('./temp-scrub.js');

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
// The packs' own paths: va-mmcx-terminal-farm and metamask-mobile-farm.
const terminalProject = {
  paths: { runtime_dir: 'temp/farmslot', artifact_dir: 'temp/tasks' },
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
const mobileProject = { paths: { runtime_dir: 'temp/recipe/runtime', artifact_dir: 'temp/tasks' } };
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
    resourceManifest: {
      capturedAt: '2026-11-25T07:30:00.000Z',
      resources: [],
      capabilityLeases: [],
    },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped', resources: [] },
    createdAt: '2026-11-25T07:30:00.000Z',
    updatedAt: '2026-11-25T07:30:10.000Z',
  };
}
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
  const dispatched = slotRun('TAT-4900', 'feat', 'live-1125-080000', { status: 'monitoring' });
  // Past slot finding: the slot is the run's, not a request.
  const live = runs.updateRun(dispatched.id, {
    steps: dispatched.steps.map((entry) =>
      entry.name === 'find-slot' ? { ...entry, status: 'done' } : entry,
    ),
  })!;
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

test('nested checkouts are deleted outright and named with their kind', async () => {
  const clone = path.join(repo, 'temp/tasks/goal3-clone');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(clone, 'answer.ts'), 'the held-out answer\n');
  // A shallow or unborn repo needs no special handling: it is only deleted.
  const linked = path.join(repo, 'temp/tasks/feat/wt-1125-070000/wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', linked);
  const run = slotRun('TAT-5200', 'feat', 'new-1125-110000');

  const outcome = await scrubTempForRun(vars, terminalProject, run);

  assert.deepEqual(outcome?.refused, []);
  assert.deepEqual(outcome?.checkouts.map(({ path: p, kind }) => [p, kind]).sort(), [
    ['temp/tasks/feat/wt-1125-070000/wt', 'linked worktree (branch wt-branch kept)'],
    ['temp/tasks/goal3-clone', 'clone'],
  ]);
  assert.equal(present('temp/tasks/goal3-clone'), false);
  assert.equal(present('temp/tasks/feat/wt-1125-070000'), false);
  assert.doesNotMatch(git(repo, 'worktree', 'list'), /wt-1125-070000/);
  assert.equal(
    git(repo, 'for-each-ref', 'refs/farmslot/'),
    '',
    'nothing is parked in the slot repo',
  );
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

test('the clear-out names every entry it removed or kept, up to the cap, then counts the rest', () => {
  const checkout = { path: 'temp/tasks/goal3-clone', kind: 'clone' };
  const linked = {
    path: 'temp/tasks/feat/wt-1125-070000/wt',
    kind: 'linked worktree (branch wt kept)',
  };
  const taskDir = { path: 'temp/tasks/feat/old-1124-090000', kind: 'dir' };
  // A checkout with its own TASK.md is a task dir too: it is listed once, as a checkout.
  const checkoutTask = { path: 'temp/tasks/feat/clone-1124-080000', kind: 'clone' };
  const others = Array.from({ length: 60 }, (_, i) => ({
    path: `temp/probe-${String(i).padStart(2, '0')}.json`,
    kind: 'file',
  }));
  const kept = Array.from({ length: 52 }, (_, i) => ({
    path: `temp/link-${i}`,
    reason: 'a symlink holding a kept path',
  }));
  const outcome = {
    // The scrub reports the children of a dir it walked, as well as the dir.
    removed: [
      taskDir,
      { path: `${taskDir.path}/TASK.md`, kind: 'file' },
      checkout,
      linked,
      checkoutTask,
      ...others,
    ],
    kept,
    refused: [],
    checkouts: [checkout, linked, checkoutTask],
    taskDirs: [
      { path: taskDir.path, runId: 'abcdef1234567890', bundle: 'in its bundle' },
      { path: checkoutTask.path, runId: null, bundle: 'no run record' },
    ],
  };

  const receipt = tempScrubReceipt(outcome);

  assert.equal(TEMP_SCRUB_LISTED, 50);
  assert.equal(
    receipt.removedCount,
    64,
    '3 checkouts, 1 task dir, 60 files; no child, no duplicate',
  );
  assert.equal(receipt.removed.length, 50);
  assert.deepEqual(receipt.removed.slice(0, 5), [
    { type: 'checkout', path: 'temp/tasks/goal3-clone', kind: 'clone' },
    { type: 'checkout', path: linked.path, kind: linked.kind },
    { type: 'checkout', path: checkoutTask.path, kind: 'clone' },
    { type: 'task-dir', path: taskDir.path, run: 'abcdef1234567890', bundle: 'in its bundle' },
    { type: 'entry', path: 'temp/probe-00.json', kind: 'file' },
  ]);
  assert.equal(receipt.keptCount, 52);
  assert.equal(receipt.kept.length, 50);
  assert.equal(receipt.refusedCount, 0);

  const lines = tempScrubLines(receipt);
  assert.equal(lines[0], 'Deleted nested clone temp/tasks/goal3-clone');
  assert.equal(lines[1], `Deleted nested linked worktree (branch wt kept) ${linked.path}`);
  assert.equal(lines[3], `Removed earlier task dir ${taskDir.path} (run abcdef12, in its bundle)`);
  assert.equal(lines[4], 'Removed file temp/probe-00.json');
  assert.equal(lines[49], 'Removed file temp/probe-45.json');
  assert.equal(lines[50], '14 more removed temp/ entries not listed');
  assert.equal(lines[51], 'Left temp/link-0: a symlink holding a kept path');
  assert.equal(lines[101], '2 more kept temp/ entries not listed');
  assert.equal(lines.length, 102);
  assert.equal(
    tempScrubLines({ ...receipt, removedCount: 51 }).at(50),
    '1 more removed temp/ entry not listed',
  );
  assert.equal(
    tempScrubSummary(receipt),
    'Cleared temp/ for this run: removed 64 entries, kept 52 entries',
  );
  assert.equal(
    tempScrubSummary({ ...receipt, removedCount: 1, keptCount: 0 }),
    'Cleared temp/ for this run: removed 1 entry, kept 0 entries',
  );
  assert.equal(
    tempScrubSummary({ ...receipt, removedCount: 0, keptCount: 0, refusedCount: 1 }),
    'temp/ clear-out refused 1 entry; removed 0 entries, kept 0 entries',
  );
  assert.equal(
    tempScrubSummary({ ...receipt, removedCount: 0, keptCount: 0 }),
    null,
    'nothing to report',
  );
});

test('a task dir inside a removed checkout or another task dir is not listed again', () => {
  const clone = { path: 'temp/tasks/other-clone', kind: 'clone' };
  const nested = { path: 'temp/tasks/flat/inner-clone', kind: 'clone' };
  const receipt = tempScrubReceipt({
    removed: [
      clone,
      { path: 'temp/tasks/flat', kind: 'dir' },
      { path: 'temp/tasks/flat/notes.md', kind: 'file' },
      nested,
    ],
    kept: [],
    refused: [],
    checkouts: [clone, nested],
    taskDirs: [
      { path: 'temp/tasks/other-clone/sub', runId: null, bundle: 'no run record' },
      { path: 'temp/tasks/flat', runId: null, bundle: 'no run record' },
      { path: 'temp/tasks/flat/sub', runId: null, bundle: 'no run record' },
    ],
  });
  assert.deepEqual(
    receipt.removed.map((entry) => `${entry.type} ${entry.path}`),
    [
      'checkout temp/tasks/other-clone',
      // A checkout inside a task dir is its own deletion.
      'checkout temp/tasks/flat/inner-clone',
      'task-dir temp/tasks/flat',
    ],
  );
  assert.equal(receipt.removedCount, 3);
});

test('the clear-out record clips a long path or reason', () => {
  const long = `temp/${'x'.repeat(400)}`;
  const receipt = tempScrubReceipt({
    removed: [{ path: long, kind: 'file' }],
    kept: [],
    refused: [{ path: long, reason: 'y'.repeat(400) }],
    checkouts: [],
    taskDirs: [],
  });
  const [entry] = receipt.removed;
  assert.equal(entry?.path.length, 300);
  const kinded = tempScrubReceipt({
    removed: [],
    kept: [],
    refused: [],
    checkouts: [{ path: 'temp/wt', kind: `linked worktree (branch ${'b'.repeat(400)} kept)` }],
    taskDirs: [],
  });
  const [linked] = kinded.removed;
  assert.equal(
    linked?.type === 'checkout' ? linked.kind.length : 0,
    300,
    'a long branch name is clipped too',
  );
  assert.ok(entry?.path.endsWith('…'));
  assert.equal(receipt.refused[0]?.reason.length, 300);
});

test('a task dir inside a refused checkout is not recorded as removed', async () => {
  const clone = path.join(repo, 'temp/tasks/held-clone');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q', '-b', 'main');
  git(
    clone,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  );
  // A worktree outside temp/ makes the scrub refuse the repository and leave it whole.
  const outside = mkdtempSync(path.join(tmpdir(), 'temp-scrub-outside-wt-'));
  git(clone, 'worktree', 'add', '-q', '-b', 'held', path.join(outside, 'wt'));
  mkdirSync(path.join(clone, 'sub'), { recursive: true });
  writeFileSync(path.join(clone, 'sub/TASK.md'), '# a task inside the clone\n');
  const run = slotRun('TAT-5400', 'feat', 'new-1125-130000');
  try {
    const outcome = await scrubTempForRun(vars, terminalProject, run);
    assert.ok(outcome);
    assert.deepEqual(
      outcome.refused.map((entry) => entry.path),
      ['temp/tasks/held-clone'],
    );
    assert.deepEqual(
      outcome.taskDirs.map((dir) => dir.path),
      [],
      'the task dir inside stayed',
    );
    assert.equal(present('temp/tasks/held-clone/sub/TASK.md'), true);
    const receipt = tempScrubReceipt(outcome);
    assert.ok(!receipt.removed.some((entry) => entry.path.startsWith('temp/tasks/held-clone')));
    assert.equal(receipt.refusedCount, 1);
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    finish(run);
  }
});

test('a refused temp/ records no task dir under it as removed', async () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'temp-scrub-outside-'));
  mkdirSync(path.join(outside, 'tasks/feat/old-1124-090000'), { recursive: true });
  writeFileSync(path.join(outside, 'tasks/feat/old-1124-090000/TASK.md'), '# earlier task\n');
  const temp = path.join(repo, 'temp');
  const parked = path.join(root, 'temp-parked-for-symlink');
  const hadTemp = existsSync(temp);
  if (hadTemp) renameSync(temp, parked);
  symlinkSync(outside, temp);
  const run = slotRun('TAT-5300', 'feat', 'new-1125-120000');
  try {
    const outcome = await scrubTempForRun(vars, terminalProject, run);
    assert.ok(outcome);
    assert.deepEqual(
      outcome.refused.map((entry) => entry.path),
      ['temp'],
    );
    assert.deepEqual(outcome.taskDirs, [], 'nothing under a refused temp/ went');
    const receipt = tempScrubReceipt(outcome);
    assert.equal(receipt.removedCount, 0);
    assert.equal(receipt.refusedCount, 1);
    assert.equal(existsSync(path.join(outside, 'tasks/feat/old-1124-090000/TASK.md')), true);
  } finally {
    unlinkSync(temp);
    if (hadTemp) renameSync(parked, temp);
    rmSync(outside, { recursive: true, force: true });
    finish(run);
  }
});
