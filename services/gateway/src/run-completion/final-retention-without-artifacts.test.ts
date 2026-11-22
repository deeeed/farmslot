import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import type { Run, RunStep } from '@farmslot/protocol';
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
mock.module('./artifact-mirror.js', {
  namedExports: {
    ...mirror,
    refreshArtifactMirror: async (
      _run: Run,
      options: { requireSourceArtifacts?: boolean } = {},
    ) => {
      if (options.requireSourceArtifacts)
        throw new Error('artifact mirror refresh has no source artifacts');
      return 0;
    },
  },
});

const { createRun, updateRun } = await import('../runs/store.js');
const { retainFinalRunArtifacts } = await import('./output.js');

function step(name: string, status: RunStep['status']): RunStep {
  return { name, status, startedAt: '2026-11-22T05:04:11.000Z' };
}

async function failedRun(steps: RunStep[], promptDeliveryStartedAt?: string): Promise<string> {
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
    agentContexts: [
      {
        id: 'fix-bug',
        role: 'fix-bug',
        label: 'Worker',
        slotId: 'macpro-audiolab-2',
        runId: run.id,
        status: 'failed',
        ...(promptDeliveryStartedAt ? { promptDeliveryStartedAt } : {}),
      },
    ],
  });
  return run.id;
}

// Run 942d189f: the task was written, then preparation failed before any worker ran, so
// slot recovery's final retention refused forever and parked the checkout each time.
test('final retention of a run whose worker never ran and retained nothing has nothing to keep', async () => {
  const runId = await failedRun([
    step('find-slot', 'done'),
    step('write-task', 'done'),
    step('prepare', 'failed'),
    step('dispatch', 'skipped'),
  ]);
  assert.equal(await retainFinalRunArtifacts(runId), 0);
});

test('final retention still refuses a missing source once the worker ran', async () => {
  const runId = await failedRun([
    step('write-task', 'done'),
    step('prepare', 'done'),
    step('dispatch', 'done'),
    step('monitor', 'failed'),
  ]);
  await assert.rejects(retainFinalRunArtifacts(runId), /no source artifacts/);
});

// Its first attempt: dispatch preflight failed (the yarn token) before the worker had its prompt.
test('final retention of a dispatch that failed before handing over the task has nothing to keep', async () => {
  const runId = await failedRun([
    step('write-task', 'done'),
    step('prepare', 'done'),
    step('dispatch', 'failed'),
  ]);
  assert.equal(await retainFinalRunArtifacts(runId), 0);
});

test('final retention still refuses a missing source once a failed dispatch began handing over the task', async () => {
  const runId = await failedRun(
    [step('write-task', 'done'), step('prepare', 'done'), step('dispatch', 'failed')],
    '2026-11-22T05:05:00.000Z',
  );
  await assert.rejects(retainFinalRunArtifacts(runId), /no source artifacts/);
});
