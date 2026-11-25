import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import type { RunOutput } from '@farmslot/protocol';

// A held-out trial must not find earlier runs' tasks or scratch in temp/. Release runs for
// real against a temp repo (its Git and the scratch/task-dir commands); the slot row lives in
// memory and tmux, process and runtime probes stay inert. Mocks load before release.js.
const root = mkdtempSync(path.join(tmpdir(), 'release-temp-scrub-'));
const runRoot = path.join(root, 'runs');
const parkHome = path.join(root, 'park-home');
for (const dir of [runRoot, path.join(root, 'home'), path.join(root, 'pool'), parkHome])
  mkdirSync(dir);
process.env.FARMSLOT_RUNS_DIR = runRoot;
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
after(() => rmSync(root, { recursive: true, force: true }));

const SLOT_ID = 'macpro-mme-1';
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
let repo = '';
let slotRow: Record<string, unknown>;

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const applies = (
  predicate: (slot: Record<string, unknown>) => boolean,
  fields: Record<string, unknown>,
) => {
  if (!predicate(slotRow)) return false;
  slotRow = { ...slotRow, ...fields };
  return true;
};
const execForTest = async (_vars: unknown, cmd: string) => {
  if (cmd.startsWith(': farmslot-runner-daemon-census'))
    return ok('--records--\n{"home":"/slot-runtime","records":[]}');
  if (/\btmux\b/.test(cmd)) return { stdout: '', stderr: 'no server running', exitCode: 1 };
  if (!cmd.includes(repo) || cmd.startsWith('identityfile=')) return ok();
  const result = spawnSync('bash', ['-c', cmd], {
    cwd: repo,
    env: gitEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
};

await import('../../runtime/mock-pty.test-support.js');
const realState = await import('../../core/state.js');
mock.module('../../core/state.js', {
  namedExports: {
    ...realState,
    readSlotRow: async () => slotRow,
    updateSlotStatusIf: async (
      _id: string,
      predicate: (row: Readonly<Record<string, unknown>>) => boolean,
      fields: Record<string, unknown>,
    ) => applies(predicate, fields),
  },
});
const realExec = await import('../../core/exec.js');
mock.module('../../core/exec.js', { namedExports: { ...realExec, execOnSlot: execForTest } });
const realScaffolding = await import('../../fleet/slot-scaffolding.js');
mock.module('../../fleet/slot-scaffolding.js', {
  namedExports: {
    ...realScaffolding,
    excludeSlotScaffolding: async () => undefined,
    archiveSlotScaffolding: async (
      _vars: unknown,
      _project: unknown,
      options: { destination: string; beforeRemove?: () => Promise<void> },
    ) => {
      await options.beforeRemove?.();
      return { roots: 0, directory: options.destination };
    },
  },
});
const realCore = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    loadSlotVars: async () => ({
      slotId: SLOT_ID,
      remoteRepo: repo,
      host: 'macpro',
      machine: 'macpro',
      projectName: 'fixture',
      resourceVars: {},
      machineEnv: { FARMSLOT_HOME: parkHome },
    }),
    loadProjectVars: async () => ({
      runtimeDir: '.agent',
      projectJson: { default_branch: 'main', task_dir: 'temp/tasks' },
    }),
    readSlotField: async (_slotId: string, field: string) => slotRow[field] ?? null,
    readSlotRow: async () => slotRow,
    updateSlotStatus: async (_slotId: string, fields: Record<string, unknown>) => {
      slotRow = { ...slotRow, ...fields };
    },
    markSlotStatusIf: async (
      _slotId: string,
      predicate: (slot: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => ({ applied: applies(predicate, fields), epoch: Number(slotRow.slot_epoch) }),
    updateSlotStatusIf: async (
      _slotId: string,
      predicate: (slot: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => applies(predicate, fields),
    resetSlotIf: async (_id: string, predicate: (row: Record<string, unknown>) => boolean) => {
      if (!predicate(slotRow)) return false;
      slotRow = { ...slotRow, current_run_id: null, lifecycle: 'ready', phase: null };
      return true;
    },
    execOnSlot: execForTest,
  },
});
const realStorage = await import('../../fleet/slot-storage-cleanup.js');
mock.module('../../fleet/slot-storage-cleanup.js', {
  namedExports: {
    ...realStorage,
    cleanupSlotStorage: async () => ({ deleted: [], skipped: [] }),
  },
});
const realTmux = await import('../../core/tmux.js');
mock.module('../../core/tmux.js', {
  namedExports: { ...realTmux, resolveTmuxSession: async () => SLOT_ID },
});
const realAttachments = await import('../terminal-attachment.js');
mock.module('../terminal-attachment.js', {
  namedExports: { ...realAttachments, terminalAttachmentCleanup: async () => ({ removed: [] }) },
});

const realRuns = await import('../../runs/store.js');
const { slotRelease } = await import('./release.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim();
}

const bundle = {
  storeId: 'local',
  bundleDigest: 'sha256:retained',
  taskKey: 'task',
  manifestDigest: 'sha256:manifest',
};
const failedCapture: RunOutput = {
  capturedAt: '2026-11-25T00:00:00.000Z',
  workerFinished: true,
  artifactManifest: [],
  manifestDigest: 'sha256:empty',
  captureError: 'store full',
};

/** A slot repo on main whose temp/ holds earlier runs' task dirs and scratch. */
function slotWithLeftovers(label: string) {
  const dir = path.join(root, label);
  repo = path.join(dir, 'repo');
  const upstream = path.join(dir, 'upstream.git');
  mkdirSync(repo, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', upstream);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, '.gitignore'), 'temp/\n');
  writeFileSync(path.join(repo, 'value.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'remote', 'add', 'origin', upstream);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const write = (rel: string) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), 'answer');
  };
  write('temp/tasks/feat/tat-4752-1123-101010/TASK.md');
  write('temp/tasks/feat/tat-4752-1123-101010/artifacts/fix.diff');
  write('temp/tasks/fix/tat-4591-1111-173307/TASK.md');
  write('temp/scratch-tat4752/fix-notes.md');
}

function finishedRun(ticket: string, task: string, retained: boolean) {
  const run = realRuns.createRun(
    { flowType: 'dev', project: 'fixture', ticketOrPr: ticket, slotId: SLOT_ID },
    { deferBackgroundPersist: true },
  );
  realRuns.updateRun(run.id, {
    status: 'done',
    taskFile: path.join(repo, 'temp/tasks', task, 'TASK.md'),
    ...(retained ? { artifactBundle: bundle } : { output: failedCapture }),
  });
  return run.id;
}

const parked = () =>
  existsSync(path.join(parkHome, 'parked-scratch')) ? readdirSync(parkHome) : [];

beforeEach(() => {
  slotRow = { slot: SLOT_ID, lifecycle: 'ready', phase: null, slot_epoch: 9 };
  rmSync(path.join(parkHome, 'parked-scratch'), { recursive: true, force: true });
});

test("release leaves no earlier run's retained task dir or scratch in temp/", async () => {
  slotWithLeftovers('retained');
  finishedRun('TAT-4752', 'feat/tat-4752-1123-101010', true);
  const notRetained = finishedRun('TAT-4591', 'fix/tat-4591-1111-173307', false);
  finishedRun('TAT-4800', 'feat/tat-4800-1124-090000', true);

  const result = await slotRelease({ slotId: SLOT_ID, forceReset: true }, () => {});

  assert.deepEqual(result, { released: true });
  assert.equal(existsSync(path.join(repo, 'temp/tasks/feat/tat-4752-1123-101010')), false);
  assert.equal(existsSync(path.join(repo, 'temp/scratch-tat4752')), false);
  assert.deepEqual(parked(), [], 'scratch is deleted, not parked, once the bundle has the run');
  // A run whose bundle copy failed keeps its task dir.
  assert.equal(realRuns.getRun(notRetained)?.output?.captureError, 'store full');
  assert.equal(existsSync(path.join(repo, 'temp/tasks/fix/tat-4591-1111-173307/TASK.md')), true);
});

test("when the releasing run's bundle copy failed, its scratch is kept off the checkout", async () => {
  slotWithLeftovers('capture-failed');
  finishedRun('TAT-4801', 'feat/tat-4801-1124-100000', false);

  const result = await slotRelease({ slotId: SLOT_ID, forceReset: true }, () => {});

  assert.deepEqual(result, { released: true });
  assert.equal(existsSync(path.join(repo, 'temp/scratch-tat4752')), false);
  assert.deepEqual(parked(), ['parked-scratch'], 'parked, not deleted');
});
