import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test, type TestContext } from 'node:test';

import {
  PipelineSteps,
  type RunnerPromptAcceptance,
  type RunReviewResult,
  type WorkerSignal,
} from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'review-startup-recovery-'));
process.env.FARMSLOT_HOME = root;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'review-owner';
after(() => rmSync(root, { recursive: true, force: true }));
await import('../runtime/mock-pty.test-support.js');

let signal: WorkerSignal | null = null;
let acceptance: RunnerPromptAcceptance | null = null;
let afterAcceptance: (() => void) | undefined;
let launches = 0;
let stops = 0;
let unavailableRunId: string | undefined;
const result: RunReviewResult = {
  recommendation: 'APPROVE',
  reviewMd: 'Frozen head reviewed.',
  lineComments: [],
};
mock.module('./task.js', {
  namedExports: {
    reviewWorkspaceProgressLocation: async () => ({
      io: { host: 'localhost', machine: 'local', sshTarget: '' },
      taskDir: '/owned/task',
      checklistPath: '/owned/task/CHECKLIST.md',
    }),
    materializeReviewWorkspaceTask: async () => {
      launches++;
      throw new Error('Recovery must not recreate the task or dispatch a reviewer');
    },
    readReviewWorkspaceSignal: async (runId: string) => {
      if (runId === unavailableRunId) throw new Error('Execution node is offline');
      return signal;
    },
    readReviewWorkspaceCompletion: async () =>
      signal?.status === 'complete' ? { signal, result } : null,
    collectReviewWorkspaceSubtaskMetrics: async () => null,
    readReviewWorkspaceProgress: async () => null,
    refreshReviewWorkspaceView: async () => 0,
  },
});
const startup = await import('../runners/review-startup.js');
mock.module('../runners/review-startup.js', {
  namedExports: {
    ...startup,
    observeReviewPromptAcceptance: async () => {
      afterAcceptance?.();
      return acceptance;
    },
  },
});
const terminal = await import('../runners/review-tmux.js');
mock.module('../runners/review-tmux.js', {
  namedExports: {
    ...terminal,
    reviewTmuxOperation: async () => {
      stops++;
      throw new Error('No terminal operation is allowed in startup recovery');
    },
  },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: { ...config, loadProjectVars: async () => ({ projectJson: {} }) },
});
const support = await import('./support.js');
mock.module('./support.js', {
  namedExports: { ...support, ensureReviewWorkspaceSupport: async () => {} },
});
mock.module('./progress.js', {
  namedExports: { createReviewWorkspaceProgressPublisher: () => ({ publish: async () => null }) },
});
const { createRun, getRun, updateRun, updateRunStep, persistRunNow } =
  await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
const {
  admitReviewRound,
  reviewRoundAdmissionId,
  runReviewRoundBudget,
  settleReviewRoundNoVerdict,
} = await import('../review/review-round-budget.js');
const {
  executeReviewWorkspaceStep,
  reconcileReviewWorkspaceStartup,
  reconcileReviewWorkspaceCleanup,
} = await import('./pipeline.js');

beforeEach(() => {
  signal = null;
  acceptance = null;
  afterAcceptance = undefined;
  launches = 0;
  stops = 0;
  unavailableRunId = undefined;
});

async function fixture(t: TestContext, ticketOrPr = 'example/mobile#42') {
  const created = createRun(
    {
      project: 'farm',
      flowType: 'review-pr',
      ticketOrPr,
      runner: 'claude',
      model: 'opus',
      transport: 'tmux',
      reviewWorkspaceTarget: { machine: 'review-node' },
    },
    { nativeOwnerPrincipalId: 'review-owner' },
  );
  const delivered = '2026-10-22T05:52:45.277Z';
  const run = updateRun(created.id, {
    status: 'reconciling',
    slotId: null,
    error: 'Reviewer has not acknowledged its task.',
    engineState: { generation: 0, workspaceReviewDispatchGeneration: 0 },
    reviewRoundAdmissions: [],
    steps: [
      { name: PipelineSteps.DISPATCH, status: 'done', outputs: { session: 'original-reviewer' } },
      { name: PipelineSteps.MONITOR, status: 'done', detail: 'review-startup-unacknowledged' },
      { name: PipelineSteps.HUMAN_GATE, status: 'skipped' },
      { name: PipelineSteps.COMPLETE, status: 'skipped' },
    ],
    reviewWorkspace: {
      workspaceId: created.id,
      machine: 'review-node',
      executionNodeId: 'review-node',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
    },
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        status: 'waiting',
        runId: created.id,
        slotId: null,
        runner: 'claude',
        model: 'opus',
        runnerSessionId: 'original-session',
        target: { session: 'original-reviewer', target: 'original-reviewer' },
        promptDeliveryStartedAt: delivered,
        attemptStartedAt: delivered,
        signalAttemptId: 'original-attempt',
      },
    ],
  });
  const round = reviewRoundAdmissionId(`workspace-review-${run.id}`, 1, run.createdAt);
  await admitReviewRound(run.id, round);
  await settleReviewRoundNoVerdict(run.id, round, 'review-startup-unacknowledged');
  t.after(async () => {
    const current = getRun(run.id)!;
    await persistRunNow(
      updateRun(run.id, {
        reviewWorkspace: { ...current.reviewWorkspace!, cleanedAt: new Date().toISOString() },
      }),
    );
    await deleteTestRunIfPresent(run.id);
  });
  return { run, round, delivered };
}

test('late exact-prompt acknowledgement resumes the original monitor and its refunded round once', async (t) => {
  const { run, round, delivered } = await fixture(t);
  acceptance = {
    runner: 'claude',
    deliveryStartedAt: delivered,
    sessionId: 'original-session',
    sessionPath: '/sessions/original.jsonl',
    observedAt: Date.parse(delivered) + 360_000,
  };
  const resumed: string[] = [];
  await reconcileReviewWorkspaceStartup(
    () => {},
    (id) => resumed.push(id),
  );
  await reconcileReviewWorkspaceStartup(
    () => {},
    (id) => resumed.push(id),
  );
  const current = getRun(run.id)!;
  assert.deepEqual(resumed, [run.id]);
  assert.equal(current.status, 'monitoring');
  assert.equal(current.error, undefined);
  assert.deepEqual(
    current.steps.map((step) => step.status),
    ['done', 'pending', 'pending', 'pending'],
  );
  assert.deepEqual(current.steps[0].outputs, { session: 'original-reviewer' });
  assert.deepEqual(current.reviewRoundAdmissions, [round]);
  assert.equal((await runReviewRoundBudget(current)).used, 1);
  assert.equal(current.agentContexts?.[0].runnerSessionId, 'original-session');
  assert.equal(launches, 0);
});

test('a late terminal signal is ingested through the same monitor without another reviewer', async (t) => {
  const { run, round, delivered } = await fixture(t);
  signal = {
    status: 'complete',
    outcome: 'success',
    attemptId: 'original-attempt',
    timestamp: new Date(Date.parse(delivered) + 360_000).toISOString(),
  };
  let resumed = 0;
  await reconcileReviewWorkspaceStartup(
    () => {},
    () => resumed++,
  );
  updateRunStep(run.id, PipelineSteps.MONITOR, {
    status: 'running',
    startedAt: new Date().toISOString(),
  });
  const outputs = await executeReviewWorkspaceStep(run.id, PipelineSteps.MONITOR, 0, () => {});
  assert.equal(resumed, 1);
  assert.deepEqual(getRun(run.id)?.reviewResult, result);
  assert.deepEqual(outputs.outputs?.workerSignal, signal);
  assert.deepEqual(getRun(run.id)?.reviewRoundAdmissions, [round]);
  assert.equal(
    getRun(run.id)?.steps.find((step) => step.name === PipelineSteps.HUMAN_GATE)?.status,
    'pending',
  );
  assert.equal(launches, 0);
});

test('missing evidence stays held; paused, cancelled and disabled runs are never resumed', async (t) => {
  const { run, delivered } = await fixture(t);
  let resumed = 0;
  await reconcileReviewWorkspaceStartup(
    () => {},
    () => resumed++,
  );
  assert.equal(getRun(run.id)?.status, 'reconciling');
  acceptance = {
    runner: 'claude',
    deliveryStartedAt: delivered,
    sessionId: 'original-session',
    sessionPath: '/sessions/original.jsonl',
    observedAt: Date.now(),
  };
  for (const status of ['paused', 'cancelled', 'done', 'failed'] as const) {
    updateRun(run.id, { status });
    await reconcileReviewWorkspaceStartup(
      () => {},
      () => resumed++,
    );
    assert.equal(getRun(run.id)?.status, status);
  }
  updateRun(run.id, { status: 'reconciling', autoRecoveryDisabled: true });
  await reconcileReviewWorkspaceStartup(
    () => {},
    () => resumed++,
  );
  assert.equal(getRun(run.id)?.status, 'reconciling');
  assert.equal(resumed, 0);
});

test('a run whose publication gate already advanced is not a startup recovery candidate', async (t) => {
  const { run, delivered } = await fixture(t);
  acceptance = {
    runner: 'claude',
    deliveryStartedAt: delivered,
    sessionId: 'original-session',
    sessionPath: '/sessions/original.jsonl',
    observedAt: Date.now(),
  };
  updateRunStep(run.id, PipelineSteps.HUMAN_GATE, { status: 'done' });
  let resumed = 0;
  await reconcileReviewWorkspaceStartup(
    () => {},
    () => resumed++,
  );
  assert.equal(resumed, 0);
  assert.equal(getRun(run.id)?.status, 'reconciling');
});

test('an operator pause or replacement attempt during the evidence read fences late adoption', async (t) => {
  const { run, delivered } = await fixture(t);
  acceptance = {
    runner: 'claude',
    deliveryStartedAt: delivered,
    sessionId: 'original-session',
    sessionPath: '/sessions/original.jsonl',
    observedAt: Date.now(),
  };
  let resumed = 0;
  afterAcceptance = () => updateRun(run.id, { status: 'paused' });
  await reconcileReviewWorkspaceStartup(
    () => {},
    () => resumed++,
  );
  assert.equal(getRun(run.id)?.status, 'paused');
  updateRun(run.id, { status: 'reconciling' });
  afterAcceptance = () => {
    const current = getRun(run.id)!;
    updateRun(run.id, {
      agentContexts: current.agentContexts!.map((context) => ({
        ...context,
        signalAttemptId: 'replacement-attempt',
      })),
    });
  };
  await reconcileReviewWorkspaceStartup(
    () => {},
    () => resumed++,
  );
  assert.equal(resumed, 0);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 0);
});

test('cleanup retains a reviewer waiting for late acknowledgement, including disabled recovery', async (t) => {
  const { run } = await fixture(t);
  updateRun(run.id, { status: 'blocked', autoRecoveryDisabled: true });
  await reconcileReviewWorkspaceCleanup(() => {});
  assert.equal(stops, 0);
  assert.equal(getRun(run.id)?.reviewWorkspace?.cleanedAt, undefined);
});

test('an unavailable node retains its attempt while a healthy reviewer reaches its monitor', async (t) => {
  const offline = await fixture(t, 'example/mobile#37961');
  const healthy = await fixture(t, 'example/mobile#37146');
  unavailableRunId = offline.run.id;
  acceptance = {
    runner: 'claude',
    deliveryStartedAt: healthy.delivered,
    sessionId: 'original-session',
    sessionPath: '/sessions/original.jsonl',
    observedAt: Date.now(),
  };
  const resumed: string[] = [];
  await reconcileReviewWorkspaceStartup(
    () => {},
    (id) => resumed.push(id),
  );
  assert.deepEqual(resumed, [healthy.run.id]);
  assert.equal(getRun(offline.run.id)?.status, 'reconciling');
  assert.match(getRun(offline.run.id)?.error ?? '', /Execution node is offline/);
  assert.equal((await runReviewRoundBudget(getRun(offline.run.id)!)).used, 0);
  assert.equal((await runReviewRoundBudget(getRun(healthy.run.id)!)).used, 1);
  unavailableRunId = undefined;
  await reconcileReviewWorkspaceStartup(
    () => {},
    (id) => resumed.push(id),
  );
  assert.deepEqual(resumed, [healthy.run.id, offline.run.id]);
  assert.equal(launches, 0);
  assert.equal(stops, 0);
});
