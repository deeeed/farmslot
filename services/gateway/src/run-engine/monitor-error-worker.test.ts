// F328 ce1c5583, 2026-11-02: the resumed monitor threw "terminated", the engine failed the run,
// and the failure teardown sent /exit to the live Pi worker. A step error alone is no evidence
// that an agent finished: the engine tears agents down only when they signaled or are gone.
// The slot here is unknown to the fixture farm, so no signal or exit can be read for it.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  type AgentContext,
  FLOW_STEPS,
  PipelineSteps as S,
  type Run,
  type RunStep,
} from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from './test-fixtures.js';
import {
  CANCEL_RUN_ACTION,
  REPLAY_STEP_ACTION,
  WORKER_LEFT_RUNNING_DECISION,
} from './worker-left-running.js';

let run: Run;
let released: string[] = [];
let killed: string[] = [];

let stepFailure: string | Error = 'terminated';
const stepError = async () => {
  throw stepFailure instanceof Error ? stepFailure : new Error(stepFailure);
};
mock.module('./post-dispatch-steps.js', {
  namedExports: {
    executeMonitorStep: stepError,
    executeReviewStep: stepError,
    executeCompleteStep: async () => {
      throw new Error('Unexpected complete');
    },
    executeHumanGateStep: async () => {
      throw new Error('Unexpected gate');
    },
    holdInteractiveCompletionForOperator: () => {
      throw new Error('Unexpected hold');
    },
    isFlowTerminalStep: () => false,
    readyGateReviewSubjectMatches: () => false,
    persistedUpdateBranchNeedsReview: () => false,
    shouldSkipRetrospectiveAtComplete: () => false,
    baseReviewPolicy: () => 'static-code',
    holdSlotForPublicationGate: () => {
      throw new Error('Unexpected hold');
    },
    rerunReviewIfReviewedInputsChanged: async () => false,
  },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) => (run?.id === id ? run : undefined),
    getAllRuns: () => (run ? [run] : []),
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
    updateRunStep: (_id: string, name: string, patch: Partial<RunStep>) =>
      Object.assign(run.steps.find((step) => step.name === name)!, patch),
    persistRunNow: async () => {},
  },
});
mock.module('../server.js', { namedExports: { broadcastEvent: () => {} } });
const backlog = await import('../backlog/store.js');
mock.module('../backlog/store.js', {
  namedExports: { ...backlog, markBacklogRunObserved: async () => undefined },
});
const posture = await import('./resource-posture.js');
mock.module('./resource-posture.js', {
  namedExports: { ...posture, reconcileRunPosture: async () => ({ result: undefined }) },
});
// The run owns its slot, so a failed run's cleanup releases it, which sends its agents /exit.
const core = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    readSlotRow: async (slot: string) => ({ slot, current_run_id: run.id, agent: 'working' }),
    ownsRunSlotCleanup: () => true,
  },
});
const lifecycle = await import('../methods/run/lifecycle-control.js');
mock.module('../methods/run/lifecycle-control.js', {
  namedExports: {
    ...lifecycle,
    releaseCompletedRunSlot: async (owner: Run) => {
      released.push(owner.id);
    },
  },
});
const nudge = await import('../methods/dispatch/nudge.js');
mock.module('../methods/dispatch/nudge.js', {
  namedExports: {
    ...nudge,
    teardownWorkerOnSlot: async (slot: string) => {
      killed.push(slot);
    },
  },
});
const { startRun } = await import('./orchestrator.js');
const { ReviewFixDeliveryError } = await import('../review/orchestrator.js');

function agent(id: string, role: AgentContext['role'], status: AgentContext['status']) {
  return { id, role, label: id, runner: 'pi', status, slotId: 'macpro-mm-5', runId: run.id };
}

function failingRun(at: typeof S.MONITOR | typeof S.REVIEW): Run {
  const steps = FLOW_STEPS['fix-bug'];
  released = [];
  killed = [];
  stepFailure = 'terminated';
  return makeRun({
    id: 'ce1c5583-dd9f-4664-87f2-b64f02941ee7',
    flowType: 'fix-bug',
    status: at === S.MONITOR ? 'monitoring' : 'reviewing',
    slotId: 'macpro-mm-5',
    engineState: { generation: 1 },
    steps: steps.map((name, index) => ({
      name,
      status: index < steps.indexOf(at) ? 'done' : 'pending',
    })),
  });
}

test('a monitor error leaves the live worker and its slot, blocked on a card', async () => {
  run = failingRun(S.MONITOR);
  const worker = agent('fix-bug', 'fix-bug', 'working');
  run.agentContexts = [worker];

  await startRun(run.id);

  assert.deepEqual(released, [], 'the slot is not released, so the worker gets no /exit');
  assert.deepEqual(killed, [], 'the worker is not killed');
  assert.equal(run.status, 'blocked', 'blocked runs are replayable and need attention');
  assert.equal(run.error, 'terminated');
  assert.equal(run.completedAt, undefined);
  assert.equal(run.slotId, 'macpro-mm-5');
  assert.deepEqual(run.agentContexts, [worker]);
  const card = run.decisions.find((decision) => !decision.resolvedAt);
  assert.equal(card?.type, WORKER_LEFT_RUNNING_DECISION);
  assert.match(card?.title ?? '', /worker left running after monitor error/);
  assert.match(card?.description ?? '', /^terminated\n\nStill running: fix-bug\./);
  assert.deepEqual(
    card?.actions.map((action) => action.id),
    [REPLAY_STEP_ACTION, CANCEL_RUN_ACTION],
  );
  assert.equal(run.steps.find((step) => step.name === S.MONITOR)?.status, 'failed');
  assert.equal(run.steps.find((step) => step.name === S.REVIEW)?.status, 'pending');
});

test('a review error leaves the live reviewer and the slot, blocked on a card', async () => {
  run = failingRun(S.REVIEW);
  run.agentContexts = [
    agent('fix-bug', 'fix-bug', 'complete'),
    agent('review-1', 'review', 'working'),
  ];

  await startRun(run.id);

  assert.deepEqual(released, [], 'the reviewer gets no /exit');
  assert.equal(run.status, 'blocked');
  assert.match(
    run.decisions.find((decision) => decision.type === WORKER_LEFT_RUNNING_DECISION)?.description ??
      '',
    /Still running: review-1\./,
  );
});

test('a fix delivery restart recovery could not confirm keeps its worker, blocked on a card', async () => {
  run = failingRun(S.REVIEW);
  stepFailure = new ReviewFixDeliveryError('Review-fix prompt delivery remained unconfirmed');
  run.agentContexts = [
    agent('fix-bug', 'fix-bug', 'waiting'),
    agent('review-fix', 'review-fix', 'working'),
  ];

  await startRun(run.id);

  assert.deepEqual(released, [], 'the worker gets no /exit');
  assert.deepEqual(killed, []);
  assert.equal(run.status, 'blocked');
  assert.match(
    run.decisions.find((decision) => decision.type === WORKER_LEFT_RUNNING_DECISION)?.description ??
      '',
    /Still running: fix-bug, review-fix\./,
  );
});

// R1: a deterministic refusal after the worker finished is the run's real outcome.
test('a worker-done refusal with exit evidence fails with its real reason', async () => {
  run = failingRun(S.MONITOR);
  stepFailure = 'Unsigned outgoing commit(s): 1a2b3c4';
  run.agentContexts = [agent('fix-bug', 'fix-bug', 'complete')];

  await startRun(run.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'Unsigned outgoing commit(s): 1a2b3c4');
  assert.equal(run.decisions.length, 0, 'no "left running" card for a finished worker');
  assert.deepEqual(released, [run.id]);
});
