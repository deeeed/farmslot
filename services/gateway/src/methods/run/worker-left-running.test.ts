// F328: a step error with an agent still running blocks the run on a card instead of failing
// it. The card's actions work without an engine waiting on it (after a restart as well).
import assert from 'node:assert/strict';
import test from 'node:test';

import { Events, type RunCancelParams, type RunDecision } from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

import { deleteTestRunIfPresent } from '../../run-engine/test-fixtures.js';
import {
  CANCEL_RUN_ACTION,
  holdRunOnWorkerLeftRunningCard,
  REPLAY_STEP_ACTION,
  WORKER_LEFT_RUNNING_DECISION,
  workerLeftRunningDecision,
} from '../../run-engine/worker-left-running.js';
import { createRun, getRun, updateRun, updateRunStep } from '../../runs/store.js';
import { continueResolvedRunDecision } from '../run.js';

function parkedRun(
  t: test.TestContext,
  actionId: string,
  decisionType: RunDecision['type'] = WORKER_LEFT_RUNNING_DECISION,
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

// F331: restart recovery holds an uncertain dispatch on this card with the same transition.
function dispatchHeldByRecovery(
  t: test.TestContext,
  actionId: string,
  replay: 'accepted' | 'refused' = 'accepted',
) {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: `HOLD-${actionId}` });
  t.after(() => deleteTestRunIfPresent(run.id));
  for (const name of ['find-slot', 'write-task', 'prepare'])
    updateRunStep(run.id, name, { status: 'done' });
  updateRunStep(run.id, 'dispatch', { status: 'running' });
  updateRun(run.id, { status: 'dispatching', slotId: 'held-slot' });
  holdRunOnWorkerLeftRunningCard(
    { updateRunStep, updateRun, getRun, broadcast: () => {} },
    getRun(run.id)!,
    'dispatch',
    'A gateway restart interrupted dispatch while the task prompt was being delivered.',
    ['dev'],
    { promptDeliveryUncertain: true },
  );
  const card = getRun(run.id)!.decisions[0]!;
  assert.equal(getRun(run.id)!.status, 'blocked');
  assert.equal(card.type, WORKER_LEFT_RUNNING_DECISION);
  assert.deepEqual(
    card.actions.map((action) => action.id),
    [REPLAY_STEP_ACTION, CANCEL_RUN_ACTION],
  );
  updateRun(run.id, {
    decisions: [{ ...card, resolvedAt: new Date().toISOString(), resolvedAction: actionId }],
  });
  const resumed: string[] = [];
  const cancelled: string[] = [];
  const replayed: string[] = [];
  const events: string[] = [];
  continueResolvedRunDecision(
    { runId: run.id, decisionId: card.id, actionId },
    (event) => events.push(event),
    {
      resumeRun: async (runId) => {
        resumed.push(runId);
      },
      cancelRun: async (params: RunCancelParams) => {
        cancelled.push(params.runId);
      },
      replayStep: async (params, _emit) => {
        replayed.push(`${params.runId}:${params.stepName}:${params.triggeredBy}`);
        if (replay === 'refused') throw new Error('the worker signal could not be read');
        return { run: getRun(run.id)! };
      },
    },
    getRun(run.id)!.engineState?.generation ?? 0,
  );
  return { run, card, resumed, cancelled, replayed, events };
}

test('Replay step on a DISPATCH card goes through the replay that adopts a fresh signal', async (t) => {
  const { run, resumed, cancelled, replayed } = dispatchHeldByRecovery(t, REPLAY_STEP_ACTION);
  await until(() => replayed.length > 0);
  assert.deepEqual(replayed, [`${run.id}:dispatch:operator`]);
  assert.deepEqual(resumed, [], 'not the engine resume, which would restart a finished worker');
  assert.deepEqual(cancelled, []);
});

test('Replay step on a fix round card replays REVIEW, past its output review still open', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'HOLD-FIX' });
  t.after(() => deleteTestRunIfPresent(run.id));
  for (const name of ['find-slot', 'write-task', 'prepare', 'dispatch', 'monitor'])
    updateRunStep(run.id, name, { status: 'done' });
  updateRunStep(run.id, 'review', { status: 'failed', detail: 'unconfirmed' });
  const card = workerLeftRunningDecision(getRun(run.id)!, 'review', 'unconfirmed', ['review-fix']);
  updateRun(run.id, {
    status: 'blocked',
    slotId: 'held-slot',
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Review fix',
        status: 'working',
        runId: run.id,
        slotId: 'held-slot',
      },
    ],
    decisions: [
      { ...card, resolvedAt: new Date().toISOString(), resolvedAction: REPLAY_STEP_ACTION },
      { ...card, id: 'output-review', type: 'engine_output_review' },
    ],
  });
  const replayed: string[] = [];
  const resumed: string[] = [];
  continueResolvedRunDecision(
    { runId: run.id, decisionId: card.id, actionId: REPLAY_STEP_ACTION },
    () => {},
    {
      resumeRun: async (runId) => {
        resumed.push(runId);
      },
      replayStep: async (params, _emit) => {
        replayed.push(`${params.stepName}:${params.triggeredBy}`);
        return { run: getRun(run.id)! };
      },
    },
    getRun(run.id)!.engineState?.generation ?? 0,
  );
  await until(() => replayed.length > 0);
  assert.deepEqual(replayed, ['review:operator']);
  assert.deepEqual(resumed, []);
});

test('a refused Replay step reopens the card instead of leaving a blocked run without one', async (t) => {
  const { run, card, replayed, resumed, events } = dispatchHeldByRecovery(
    t,
    REPLAY_STEP_ACTION,
    'refused',
  );
  await until(() => replayed.length > 0 && events.includes(Events.RUN_UPDATED));
  assert.deepEqual(resumed, []);
  const reopened = getRun(run.id)!.decisions.find((decision) => decision.id === card.id);
  assert.equal(reopened?.resolvedAt, undefined);
  assert.equal(getRun(run.id)!.status, 'blocked');
  assert.match(getRun(run.id)!.error ?? '', /Replay step was refused: the worker signal/);
  assert.ok(events.includes(Events.RUN_DECISION_NEW), 'clients are told the card is open again');
});

test('Cancel run on a dispatch restart recovery held cancels it', async (t) => {
  const { run, resumed, cancelled } = dispatchHeldByRecovery(t, CANCEL_RUN_ACTION);
  await until(() => cancelled.length > 0);
  assert.deepEqual(cancelled, [run.id]);
  assert.deepEqual(resumed, []);
});
