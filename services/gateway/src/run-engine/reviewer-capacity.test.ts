import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { FLOW_STEPS, PipelineSteps as S, type Run, type RunStep } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'reviewer-capacity-'));
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
after(() => rm(root, { recursive: true, force: true }));
await import('../runtime/mock-pty.test-support.js');

const { makeRun } = await import('./test-fixtures.js');
const { isReviewerCapacityError, ReviewerExitedError } =
  await import('../review/terminal-result.js');
let run: Run;
let failure: Error;
let duringReview: () => void = () => {};
let reviewCalls = 0;
const stopForCapacity = async () => {
  reviewCalls++;
  duringReview();
  throw failure;
};
mock.module('./post-dispatch-steps.js', {
  namedExports: {
    executeReviewStep: stopForCapacity,
    executeHumanGateStep: async () => assert.fail('publication review handles its own failures'),
    executeMonitorStep: async () => assert.fail('worker monitor must not rerun'),
    executeCompleteStep: async () => assert.fail('review has no verdict'),
    holdInteractiveCompletionForOperator: () => assert.fail('unexpected completion'),
    isFlowTerminalStep: () => false,
    readyGateReviewSubjectMatches: () => false,
    persistedUpdateBranchNeedsReview: () => false,
    shouldSkipRetrospectiveAtComplete: () => false,
    baseReviewPolicy: () => 'static-code',
    holdSlotForPublicationGate: () => assert.fail('unexpected publication'),
    rerunReviewIfReviewedInputsChanged: () => assert.fail('unexpected extra review'),
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
  },
});
const { startRun } = await import('./orchestrator.js');
const message = 'Selected model is at capacity. Please try a different model.';

function setup() {
  const at = S.REVIEW;
  reviewCalls = 0;
  duringReview = () => {};
  failure = new Error(message);
  const steps = FLOW_STEPS.dev;
  run = makeRun({
    id: `capacity-${at}`,
    flowType: 'dev',
    mode: 'autonomous',
    status: 'reviewing',
    slotId: 'owned-slot',
    taskFile: path.join(root, 'tasks/TASK.md'),
    engineState: { generation: 1 },
    steps: steps.map((name, index) => ({
      name,
      status: index < steps.indexOf(at) ? 'done' : 'pending',
    })),
  });
  run.reviewRoundAdmissions = ['original-no-verdict'];
  run.reviewRoundSettlements = {
    'original-no-verdict': { reason: message, at: '2026-10-29T17:16:58.248Z' },
  };
  run.agentContexts = [
    {
      id: 'original-worker',
      role: 'dev',
      label: 'Worker',
      status: 'complete',
      runId: run.id,
      slotId: run.slotId,
      runnerSessionId: 'original-session',
      taskFile: run.taskFile,
    },
  ];
}

test('review capacity refusal holds for the operator', async () => {
  setup();
  const contexts = structuredClone(run.agentContexts);
  const receipts = structuredClone(run.reviewRoundSettlements);
  const dispatch = structuredClone(run.steps.find((step) => step.name === S.DISPATCH));
  failure = new ReviewerExitedError(message);
  await startRun(run.id);
  assert.equal(run.status, 'review-failed');
  assert.equal(run.engineState?.publishGate?.reviewRecovery?.status, 'operator-required');
  assert.equal(run.engineState?.publishGate?.reviewRecovery?.lastError, message);
  assert.equal(run.steps.find((step) => step.name === S.REVIEW)?.status, 'failed');
  assert.equal(run.error, message);
  assert.equal(run.slotId, 'owned-slot');
  assert.equal(run.completedAt, undefined);
  assert.notEqual(run.metrics.outcome, 'failure');
  assert.deepEqual(run.agentContexts, contexts);
  assert.deepEqual(run.reviewRoundSettlements, receipts, 'no-verdict refund is retained');
  assert.deepEqual(
    run.steps.find((step) => step.name === S.DISPATCH),
    dispatch,
  );
  assert.equal(reviewCalls, 1, 'no unbounded retry or replacement');
});

for (const interrupt of ['cancel', 'replay'] as const) {
  test(`${interrupt} before capacity returns cannot restore an obsolete hold`, async () => {
    setup();
    duringReview = () => {
      if (interrupt === 'cancel') run.status = 'cancelled';
      else run.engineState = { generation: 2 };
    };
    await startRun(run.id);
    assert.equal(run.engineState?.publishGate?.reviewRecovery, undefined);
    assert.equal(run.status, interrupt === 'cancel' ? 'cancelled' : 'reviewing');
  });
}

test('only the observed provider capacity refusal is classified for this hold', () => {
  assert.equal(isReviewerCapacityError(new Error(message)), true);
  assert.equal(isReviewerCapacityError(new AggregateError([new Error(message)], message)), true);
  for (const other of [
    undefined,
    message,
    new Error('Invalid reviewer artifact'),
    new Error('Disk capacity is exhausted'),
    new Error('Authentication failed'),
  ])
    assert.equal(isReviewerCapacityError(other), false);
});
