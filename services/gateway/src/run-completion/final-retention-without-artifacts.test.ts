import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import type { AgentContext, Run, RunStep } from '@farmslot/protocol';
import { openRunBundleStore } from '@farmslot/run-bundle';

import '../runtime/mock-pty.test-support.js';

const root = await mkdtemp(path.join(tmpdir(), 'gateway-final-retention-'));
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_RUN_ARCHIVE_ROOT = path.join(root, 'home/run-archive');
await openRunBundleStore({
  runsDir: process.env.FARMSLOT_RUNS_DIR,
  home: process.env.FARMSLOT_HOME,
  create: true,
});
after(() => rm(root, { recursive: true, force: true }));

// The slot's task artifacts are gone, as on macpro-audiolab-2 after the failed dispatch:
// the real mirror refuses a required refresh with nothing to copy and otherwise copies none.
const mirror = await import('./artifact-mirror.js');
let mirrorOptions: { requireSourceArtifacts?: boolean; keepMirrorWithoutSource?: boolean } = {};
mock.module('./artifact-mirror.js', {
  namedExports: {
    ...mirror,
    refreshArtifactMirror: async (_run: Run, options: typeof mirrorOptions = {}) => {
      mirrorOptions = options;
      if (options.requireSourceArtifacts)
        throw new Error('artifact mirror refresh has no source artifacts');
      return 0;
    },
  },
});

const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { captureRunOutput, retainFinalRunArtifacts } = await import('./output.js');
const { BEFORE_WORKER_LAUNCH, WORKER_LAUNCH } =
  await import('../run-lifecycle/pre-worker-failure.js');

function step(name: string, status: RunStep['status'], failedPhase?: string): RunStep {
  return {
    name,
    status,
    startedAt: '2026-11-22T05:04:11.000Z',
    ...(failedPhase ? { outputs: { failedPhase } } : {}),
  };
}

async function failedRun(
  steps: RunStep[],
  context: Partial<AgentContext> | null = {},
): Promise<{ runId: string; taskDir: string }> {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example',
    ticketOrPr: 'https://github.com/deeeed/audiolab/issues/505',
  });
  const taskDir = path.join(root, run.id);
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  updateRun(run.id, {
    status: 'failed',
    slotId: 'macpro-audiolab-2',
    taskFile,
    engineState: { taskInit: { taskFile, status: 'initialized' } },
    steps,
    agentContexts: context
      ? [
          {
            id: 'fix-bug',
            role: 'fix-bug',
            label: 'Worker',
            slotId: 'macpro-audiolab-2',
            runId: run.id,
            status: 'failed',
            ...context,
          },
        ]
      : [],
  });
  return { runId: run.id, taskDir };
}

// Run 942d189f after its replay: the task was written, then preparation failed before any
// worker ran, so slot recovery's final retention refused forever and parked the checkout.
test('final retention of a run that failed before its worker launched has nothing to keep', async () => {
  const { runId } = await failedRun([
    step('find-slot', 'done'),
    step('write-task', 'done'),
    step('prepare', 'failed'),
    step('dispatch', 'skipped'),
  ]);
  assert.equal(await retainFinalRunArtifacts(runId), 0);
  // An empty source must not prune the gateway's mirrored receipt (see artifact-mirror.test).
  assert.equal(mirrorOptions.keepMirrorWithoutSource, true);
  // The capture commits a bundle; a release that fails afterwards must be retryable.
  assert.equal(await retainFinalRunArtifacts(runId), 0);
  assert.equal(mirrorOptions.keepMirrorWithoutSource, true);
});

test('final retention still refuses a missing source once the worker ran', async () => {
  const { runId } = await failedRun([
    step('write-task', 'done'),
    step('prepare', 'done'),
    step('dispatch', 'done'),
    step('monitor', 'failed'),
  ]);
  await assert.rejects(retainFinalRunArtifacts(runId), /no source artifacts/);
});

// The first attempt: dispatch preflight (the yarn token) failed after cold tmux dispatch had
// prepared the pane, but before the worker launched.
test('a dispatch recorded as failing before the worker launched has nothing to keep', async () => {
  const { runId } = await failedRun(
    [
      step('write-task', 'done'),
      step('prepare', 'done'),
      step('dispatch', 'failed', BEFORE_WORKER_LAUNCH),
    ],
    {
      target: { session: 'audiolab-2', window: 'fix-bug', target: 'audiolab-2:fix-bug' },
      startedAt: '2026-11-22T05:05:00.000Z',
    },
  );
  assert.equal(await retainFinalRunArtifacts(runId), 0);
  assert.equal(mirrorOptions.keepMirrorWithoutSource, true);
});

// Warm handoff and branch nudge can deliver the task before saving the receiving context.
test('a dispatch that failed at worker launch refuses a missing source even without a context', async () => {
  const { runId } = await failedRun(
    [
      step('write-task', 'done'),
      step('prepare', 'done'),
      step('dispatch', 'failed', WORKER_LAUNCH),
    ],
    null,
  );
  await assert.rejects(retainFinalRunArtifacts(runId), /no source artifacts/);
});

test('a dispatch failure with no recorded phase refuses a missing source', async () => {
  const { runId } = await failedRun([
    step('write-task', 'done'),
    step('prepare', 'done'),
    step('dispatch', 'failed'),
  ]);
  await assert.rejects(retainFinalRunArtifacts(runId), /no source artifacts/);
});

test('final retention decides after a queued capture commits output', async () => {
  const { runId, taskDir } = await failedRun([
    step('write-task', 'done'),
    step('prepare', 'failed'),
    step('dispatch', 'skipped'),
  ]);
  await writeFile(path.join(taskDir, 'artifacts/report.md'), '# Partial report\n');
  const snapshot = captureRunOutput(runId);
  const final = retainFinalRunArtifacts(runId);
  await snapshot;
  await assert.rejects(final, /no source artifacts/);
});

test('a retried final retention keeps what the first one retained', async () => {
  const { runId, taskDir } = await failedRun([
    step('write-task', 'done'),
    step('prepare', 'failed'),
    step('dispatch', 'skipped'),
  ]);
  const proof = path.join(taskDir, 'artifacts/repro.png');
  await writeFile(proof, 'first capture');
  await retainFinalRunArtifacts(runId);
  const kept = getRun(runId)?.artifactBundle;
  assert.ok(kept);
  // Release removed the task, then failed; the retry sees an empty source.
  await rm(proof);
  assert.equal(await retainFinalRunArtifacts(runId), 0);
  assert.deepEqual(getRun(runId)?.artifactBundle, kept);
});
