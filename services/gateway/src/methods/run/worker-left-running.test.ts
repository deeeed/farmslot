// F328: a step error with an agent still running blocks the run on a card instead of failing
// it. The card's actions work without an engine waiting on it (after a restart as well).
import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunCancelParams } from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

import { deleteTestRunIfPresent } from '../../run-engine/test-fixtures.js';
import {
  CANCEL_RUN_ACTION,
  REPLAY_STEP_ACTION,
  WORKER_LEFT_RUNNING_DECISION,
  workerLeftRunningDecision,
} from '../../run-engine/worker-left-running.js';
import { createRun, getRun, updateRun, updateRunStep } from '../../runs/store.js';
import { continueResolvedRunDecision } from '../run.js';

function parkedRun(
  t: test.TestContext,
  actionId: string,
  decisionType = WORKER_LEFT_RUNNING_DECISION,
) {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: `PARK-${actionId}` });
  t.after(() => deleteTestRunIfPresent(run.id));
  for (const name of ['find-slot', 'write-task', 'prepare', 'dispatch'])
    updateRunStep(run.id, name, { status: 'done' });
  updateRunStep(run.id, 'monitor', { status: 'failed', detail: 'terminated' });
  const card = workerLeftRunningDecision(getRun(run.id)!, 'monitor', 'terminated', ['dev']);
  updateRun(run.id, {
    status: 'blocked',
    error: 'terminated',
    slotId: 'parked-slot',
    decisions: [
      {
        ...card,
        type: decisionType,
        resolvedAt: new Date().toISOString(),
        resolvedAction: actionId,
      },
    ],
  });
  const resumed: string[] = [];
  const cancelled: string[] = [];
  continueResolvedRunDecision(
    { runId: run.id, decisionId: card.id, actionId },
    () => {},
    {
      resumeRun: async (runId) => {
        resumed.push(runId);
      },
      cancelRun: async (params: RunCancelParams) => {
        cancelled.push(params.runId);
      },
    },
    getRun(run.id)!.engineState?.generation ?? 0,
  );
  return { run, resumed, cancelled };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('Replay step on a worker-left-running card resumes the run at the failed step', async (t) => {
  const { run, resumed, cancelled } = parkedRun(t, REPLAY_STEP_ACTION);
  await until(() => resumed.length > 0);
  assert.deepEqual(resumed, [run.id]);
  assert.deepEqual(cancelled, []);
  const after = getRun(run.id)!;
  assert.equal(after.status, 'created');
  // The engine starts at the first step not done: the monitor runs again.
  assert.equal(after.steps.find((step) => step.name === 'monitor')?.status, 'failed');
  assert.equal(after.steps.find((step) => step.name === 'dispatch')?.status, 'done');
});

test('Cancel run on a worker-left-running card cancels the run instead of resuming it', async (t) => {
  const { run, resumed, cancelled } = parkedRun(t, CANCEL_RUN_ACTION);
  await until(() => cancelled.length > 0);
  assert.deepEqual(cancelled, [run.id]);
  assert.deepEqual(resumed, []);
});

test('Abort Run on a runner_unavailable card cancels the run instead of waking the monitor', async (t) => {
  const { run, resumed, cancelled } = parkedRun(t, 'abort', 'monitor_runner_unavailable');
  await until(() => cancelled.length > 0);
  assert.deepEqual(cancelled, [run.id]);
  assert.deepEqual(resumed, []);
});
