import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { Run, RunOutput } from '@farmslot/protocol';

// The scrub runs for real against a temp slot repo; only the transport and the bundle store
// are faked: `<bundles>/<runId>/manifest.json` and `<bundles>/<runId>/tasks/t/`.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'temp-scrub-run-')));
for (const dir of ['runs', 'home', 'pool', 'bundles']) mkdirSync(path.join(root, dir));
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
after(() => rmSync(root, { recursive: true, force: true }));

const realCore = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    execOnSlot: async (_vars: unknown, cmd: string) => {
      const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 30_000 });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
    },
  },
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
const {
  ownTaskDirInBundle,
  scrubTempForRun,
  shouldScrubTempForRun,
  taskBundleCheck,
  tempStatePaths,
} = await import('./temp-scrub.js');

const SLOT_ID = 'macpro-mme-1';
const repo = path.join(root, 'slot');
const vars = makeVars({ slotId: SLOT_ID, remoteRepo: repo });
const projectJson = {
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
const orchestratorTask = (flow: string, name: string) =>
  `/farm/projects/va-mmcx-terminal-farm/tasks/${flow}/${name}/TASK.md`;
const write = (rel: string) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), 'answer');
};
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
function bundleHas(run: Run, files: string[], taskRelativePath?: string) {
  const dir = path.join(root, 'bundles', run.id);
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(dir, 'tasks/t', rel)), { recursive: true });
    writeFileSync(path.join(dir, 'tasks/t', rel), 'x');
  }
  const folder = path.basename(path.dirname(path.dirname(run.taskFile!)));
  const name = path.basename(path.dirname(run.taskFile!));
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      runs: [
        {
          originalRunId: run.id,
          taskRelativePath:
            taskRelativePath ?? `projects/va-mmcx-terminal-farm/tasks/${folder}/${name}`,
        },
      ],
    }),
  );
}

test('farm state comes from the project: runtime dir and watched resource dirs', () => {
  assert.deepEqual(tempStatePaths(projectJson), [
    'temp/farmslot',
    'temp/recipe/harness',
    'temp/recipe/runtime/terminal',
    'temp/.agent/preflight.pid',
    'temp/.metadata_never_index',
  ]);
});

test('a new run clears temp/ except farm state and its own and parent task dirs', async () => {
  for (const rel of [
    'temp/farmslot/deps.lock-hash',
    'temp/recipe/runtime/terminal/browser.pid',
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

  const outcome = await scrubTempForRun(vars, projectJson, child);

  assert.ok(outcome);
  assert.deepEqual(outcome.refused, []);
  for (const kept of [
    'temp/farmslot/deps.lock-hash',
    'temp/recipe/runtime/terminal/browser.pid',
    'temp/tasks/feat/parent-1124-080000/TASK.md',
    'temp/tasks/feat/new-1125-090000/TASK.md',
  ])
    assert.equal(existsSync(path.join(repo, kept)), true, kept);
  for (const gone of [
    'temp/tasks/feat/tat-4752-1123-101010',
    'temp/tasks/fix',
    'temp/scratch-tat4752',
    'temp/tat4505-trace.json',
  ])
    assert.equal(existsSync(path.join(repo, gone)), false, gone);
  assert.deepEqual(
    outcome.taskDirs.map(({ runId, bundle }) => [runId, bundle]).sort(),
    [
      [bundled.id, 'in its bundle'],
      [unbundled.id, 'NOT in a bundle (no final bundle)'],
    ].sort(),
  );
  runs.updateRun(child.id, { status: 'failed' });
});

test('another live run on the slot stops the clear-out', async () => {
  write('temp/tasks/feat/live-1125-080000/TASK.md');
  write('temp/scratch-live/notes.md');
  const live = slotRun('TAT-4900', 'feat', 'live-1125-080000', { status: 'monitoring' });
  const fresh = slotRun('TAT-4901', 'feat', 'fresh-1125-090000');
  await assert.rejects(scrubTempForRun(vars, projectJson, fresh), /still has live run/);
  assert.equal(existsSync(path.join(repo, 'temp/scratch-live/notes.md')), true);
  for (const run of [live, fresh]) runs.updateRun(run.id, { status: 'failed' });
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
  bundleHas(run, []);
  assert.equal((await taskBundleCheck(runs.getRun(run.id)!)).confirmed, true);
  runs.updateRun(run.id, { output: { ...captured, retentionMissingData: ['media'] } });
  assert.equal((await taskBundleCheck(runs.getRun(run.id)!)).confirmed, false);
  runs.updateRun(run.id, { output: captured });

  write('temp/tasks/feat/tat-5000/TASK.md');
  write('temp/tasks/feat/tat-5000/artifacts/fix.diff');
  const slotDir = path.join(repo, 'temp/tasks/feat/tat-5000');
  assert.equal((await ownTaskDirInBundle(vars, runs.getRun(run.id)!, slotDir)).confirmed, true);
  write('temp/tasks/feat/tat-5000/late-note.md');
  assert.deepEqual(await ownTaskDirInBundle(vars, runs.getRun(run.id)!, slotDir), {
    confirmed: false,
    reason: 'late-note.md is not in the bundle',
  });
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
});
