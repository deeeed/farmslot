import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { Run, RunOutput } from '@farmslot/protocol';

// The scrub runs for real against a temp slot repo; only the transport and the bundle
// store are faked (a bundle dir per run, present or not).
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
    retainedRunTaskDirectory: async (run: Run) => path.join(root, 'bundles', run.id),
  },
});

const runs = await import('../../runs/store.js');
const { makeVars } = await import('../../runners/test-fixtures.js');
const { scrubTempForRun, shouldScrubTempForRun, taskBundleConfirmed } =
  await import('./temp-scrub.js');

const SLOT_ID = 'macpro-mme-1';
const repo = path.join(root, 'slot');
const vars = makeVars({ slotId: SLOT_ID, remoteRepo: repo });
const projectJson = { task_dir: 'temp/tasks', paths: { runtime_dir: 'temp/farmslot' } };
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
function bundleHas(run: Run, files: string[]) {
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(root, 'bundles', run.id, rel)), { recursive: true });
    writeFileSync(path.join(root, 'bundles', run.id, rel), 'x');
  }
}

test('a new run clears temp/ except farm state, its own and parent task dirs and live runs', async () => {
  for (const rel of [
    'temp/farmslot/deps.lock-hash',
    'temp/tasks/feat/tat-4752-1123-101010/TASK.md',
    'temp/tasks/fix/tat-4591-1111-173307/TASK.md',
    'temp/tasks/feat/parent-1124-080000/TASK.md',
    'temp/tasks/feat/live-1125-080000/TASK.md',
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
  const live = slotRun('TAT-4801', 'feat', 'live-1125-080000', { status: 'monitoring' });
  const child = slotRun('TAT-4802', 'feat', 'new-1125-090000', { parentRunId: parent.id });

  const outcome = await scrubTempForRun(vars, projectJson, child, { keepOwn: true });

  assert.ok(outcome);
  assert.deepEqual(outcome.refused, []);
  for (const kept of [
    'temp/farmslot/deps.lock-hash',
    'temp/tasks/feat/parent-1124-080000/TASK.md',
    'temp/tasks/feat/live-1125-080000/TASK.md',
    'temp/tasks/feat/new-1125-090000/TASK.md',
  ])
    assert.equal(existsSync(path.join(repo, kept)), true, kept);
  for (const gone of [
    'temp/tasks/feat/tat-4752-1123-101010',
    'temp/tasks/fix/tat-4591-1111-173307',
    'temp/scratch-tat4752',
    'temp/tat4505-trace.json',
  ])
    assert.equal(existsSync(path.join(repo, gone)), false, gone);
  assert.deepEqual(
    outcome.taskDirs.map(({ runId, bundled: inBundle }) => [runId, inBundle]).sort(),
    [
      [bundled.id, true],
      [unbundled.id, false],
    ].sort(),
    'each removed task dir is named with its run and whether its bundle has it',
  );
  for (const run of [live, child]) runs.updateRun(run.id, { status: 'failed' });
});

test('a bundle confirms a task dir only when it holds TASK.md and every artifact', async () => {
  const run = slotRun('TAT-4900', 'feat', 'tat-4900', { status: 'done', output: captured });
  bundleHas(run, ['TASK.md']);
  assert.equal(await taskBundleConfirmed(runs.getRun(run.id)!), false, 'an artifact is missing');
  bundleHas(run, ['artifacts/fix.diff']);
  assert.equal(await taskBundleConfirmed(runs.getRun(run.id)!), true);
  runs.updateRun(run.id, { output: { ...captured, retentionMissingData: ['media'] } });
  assert.equal(await taskBundleConfirmed(runs.getRun(run.id)!), false, 'capture was incomplete');
  runs.updateRun(run.id, { output: { ...captured, captureError: 'store full' } });
  assert.equal(await taskBundleConfirmed(runs.getRun(run.id)!), false, 'capture failed');
});

test('a warm handoff, a replay or a resumed task does not clear temp/', () => {
  const fresh = slotRun('TAT-5000', 'feat', 'fresh');
  assert.equal(shouldScrubTempForRun(fresh), true);
  assert.equal(
    shouldScrubTempForRun({ ...fresh, engineState: { flags: { warmSessionReuse: true } } }),
    false,
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
      steps: [...fresh.steps, { name: 'dispatch', status: 'done' }],
    }),
    false,
  );
  assert.equal(shouldScrubTempForRun(undefined), false, 'no run identity, no scrub');
});
