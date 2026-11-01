// ADR-065 Amendment 7: one person settles a held result through Send back,
// Accept or Close; cancel, restart and the named discard respect the hold.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import {
  FLOW_STEPS,
  isSuccessfulRun,
  pendingResultDecision,
  type PipelineStep,
  PipelineSteps as S,
  type ResultDecisionPayload,
  type Run,
  type RunReplayStepParams,
  type RunStep,
  type SlotReleaseParams,
  type WorkerSignal,
} from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from '../run-engine/test-fixtures.js';

let run: Run;
let replays: RunReplayStepParams[] = [];
let releases: SlotReleaseParams[] = [];
/** COMPLETE may already have released the slot, so the named discard finds nothing to release. */
let slotStillOwned = true;
let idleReturns: string[] = [];
let starts: string[] = [];
let replayError: Error | null = null;
let onReplay: (() => void) | null = null;
let failPersist: string | null = null;
let slotOwner: string | undefined;
let delivery: 'confirmed' | 'queued' | 'unconfirmed' | 'not-attempted' = 'confirmed';
let afterDelivery: (() => void) | undefined;
let deliveryError: Error | undefined;
let feedback: Array<{
  key: string;
  text: string;
  contextId?: string;
  observeSince?: number;
  commandId?: string;
}> = [];
const priorSignal: WorkerSignal = {
  status: 'complete',
  outcome: 'success',
  timestamp: '2026-10-28T00:16:00.000Z',
  attemptId: 'retained-attempt',
};
let currentSignal = priorSignal;
const analyticsDir = mkdtempSync(path.join(tmpdir(), 'result-decision-analytics-'));
process.env.FARMSLOT_ANALYTICS_DIR = analyticsDir;
after(() => rmSync(analyticsDir, { recursive: true, force: true }));

const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) => (run?.id === id ? run : undefined),
    getAllRuns: () => (run ? [run] : []),
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
    updateRunStep: (_id: string, name: string, patch: Partial<RunStep>) =>
      Object.assign(run.steps.find((step) => step.name === name)!, patch),
    persistRunNow: async (_run: Run, reason: string) => {
      if (failPersist === reason) throw new Error('disk full');
    },
  },
});
mock.module('../server.js', { namedExports: { broadcastEvent: () => {} } });
const state = await import('../core/state.js');
mock.module('../core/state.js', {
  namedExports: { ...state, readSlotField: async () => slotOwner ?? run.id },
});
const instructions = await import('../runners/operator-instruction.js');
mock.module('../runners/operator-instruction.js', {
  namedExports: {
    ...instructions,
    deliverOperatorInstruction: async (
      _run: Run,
      key: string,
      text: string,
      observeSince?: number,
      contextId?: string,
      commandId?: string,
    ) => {
      feedback.push({ key, text, contextId, observeSince, commandId });
      if (deliveryError) throw deliveryError;
      afterDelivery?.();
      return delivery;
    },
  },
});
const monitor = await import('../run-engine/run-monitor.js');
mock.module('../run-engine/run-monitor.js', {
  namedExports: {
    ...monitor,
    probeWorkerSignalForRun: async () => ({
      ok: monitor.isWorkerSignalFreshForRun(run, currentSignal),
      code: monitor.isWorkerSignalFreshForRun(run, currentSignal) ? 'ready' : 'stale',
      message: 'Current retained worker signal',
      signal: currentSignal,
    }),
  },
});
const backlog = await import('../backlog/store.js');
mock.module('../backlog/store.js', {
  namedExports: { ...backlog, markBacklogRunObserved: async () => undefined },
});
const posture = await import('../run-engine/resource-posture.js');
mock.module('../run-engine/resource-posture.js', {
  namedExports: { ...posture, reconcileRunPosture: async () => ({ result: undefined }) },
});
const replay = await import('../methods/run/replay-step.js');
mock.module('../methods/run/replay-step.js', {
  namedExports: {
    ...replay,
    runReplayStep: async (params: RunReplayStepParams) => {
      replays.push(params);
      if (replayError) throw replayError;
      onReplay?.();
      return { run };
    },
    continuePRCompletionStep: async (
      runId: string,
      stepName: 'monitor' | 'review' | 'complete',
      _emit: (event: string, payload: unknown) => void,
      acknowledge: () => Promise<boolean>,
    ) => {
      if (!(await acknowledge())) return { run, continued: false };
      replays.push({ runId, stepName, triggeredBy: 'operator' });
      if (replayError) throw replayError;
      onReplay?.();
      return { run, continued: true };
    },
  },
});
const release = await import('../methods/slot/release.js');
mock.module('../methods/slot/release.js', {
  namedExports: {
    ...release,
    slotRelease: async (params: SlotReleaseParams) => {
      releases.push(params);
      return { released: slotStillOwned };
    },
  },
});
const safeIdle = await import('../run-lifecycle/safe-idle-slot.js');
mock.module('../run-lifecycle/safe-idle-slot.js', {
  namedExports: {
    ...safeIdle,
    returnReleasedCheckoutToIdle: async (released: Run) => {
      idleReturns.push(released.id);
      return { kind: 'ready' as const };
    },
  },
});
const orchestrator = await import('../run-engine/orchestrator.js');
mock.module('../run-engine/orchestrator.js', {
  namedExports: {
    ...orchestrator,
    startRun: async (runId: string) => {
      starts.push(runId);
    },
  },
});

const {
  buildResultDecision,
  closeDiscardedResult,
  holdRunForResultDecision,
  resolveResultDecision,
  takeSendBackReview,
} = await import('./result-decision.js');
const {
  aggregateAnalytics,
  appendAnalyticsRecord,
  buildAnalyticsRecord,
  emitAnalyticsForTerminalRun,
  readAllAnalyticsRecords,
} = await import('../runs/analytics.js');
const { restartDisposition, representResultDecisions } = await import('../run-engine/recovery.js');
const { runCancelTransitionLocked } = await import('../methods/run/lifecycle-control.js');

beforeEach(() => {
  failPersist = null;
  replayError = null;
  onReplay = null;
  replays = [];
  releases = [];
  slotStillOwned = true;
  idleReturns = [];
  starts = [];
  slotOwner = undefined;
  delivery = 'confirmed';
  afterDelivery = undefined;
  feedback = [];
  deliveryError = undefined;
  currentSignal = priorSignal;
});

const findings = [
  {
    file: 'src/features/perpetuals/queries/invalidate-live-trading-queries.ts',
    line: 31,
    description: 'No test covers the marginModeLock invalidation AC2 rests on.',
  },
];

function stepsAt(flowType: Run['flowType'], at: PipelineStep, outputs: RunStep['outputs']) {
  const steps = FLOW_STEPS[flowType];
  return steps.map(
    (name, index): RunStep => ({
      name,
      status: index < steps.indexOf(at) ? 'done' : name === at ? 'failed' : 'pending',
      ...(name === S.MONITOR
        ? {
            outputs: {
              workerSignal: { status: 'complete' },
              pushVerification: { verified: true },
            },
          }
        : name === at
          ? { outputs }
          : {}),
    }),
  );
}

/** 8cff6e80 held after REVIEW: 1/2 fix attempts, all review rounds spent. */
async function heldOpus(admissions = 5): Promise<Run> {
  run = makeRun({
    id: '8cff6e80-6b53-44a0-9834-9f0a44631aad',
    flowType: 'dev',
    mode: 'autonomous',
    lane: 'comparison',
    status: 'failed',
    slotId: null,
    completionPolicy: 'artifact-only',
    branch: 'feat/tat-4145-opus',
    engineState: { generation: 3 },
    steps: stepsAt('dev', S.REVIEW, {
      verdict: 'issues',
      issues: findings,
      retryCount: 1,
      maxRetries: 2,
      reviewId: 'pipeline-review-1',
      mode: 'cold',
      reviewSnapshot: { headSha: '3522954d1f0b7c1f2a6c0f9d6b1e0c5a7e2d9f10' },
    }),
  });
  run.output = {
    capturedAt: '2026-10-18T10:50:00.000Z',
    workerFinished: false,
    artifactManifest: [],
    manifestDigest: '9bbbd8fd',
    reportPath: 'artifacts/pr-description.md',
  };
  run.reviewRoundAdmissions = Array.from({ length: admissions }, (_, i) => `admission-${i}`);
  const decision = await buildResultDecision(run, 'review');
  Object.assign(run, { status: 'needs-decision', decisions: [decision] });
  return run;
}

/** 3e2f400a held after a refused QA COMPLETE, with its output review pending. */
async function heldQa(): Promise<Run> {
  run = makeRun({
    id: '3e2f400a-2e87-409e-92e6-2557c5dfbc8a',
    flowType: 'qa',
    mode: 'autonomous',
    lane: 'production',
    status: 'failed',
    slotId: 'macwork-mmt-1',
    completionPolicy: 'artifact-only',
    engineState: { generation: 5 },
    steps: stepsAt('qa', S.COMPLETE, {
      gatePrerequisiteRefusal: { readiness: { state: 'not-ready', reasons: [] } },
    }),
    decisions: [
      {
        id: 'output-review-1',
        type: 'engine_output_review',
        title: 'Review run output',
        description: 'Review the captured report',
        actions: [],
        createdAt: '2026-10-16T21:40:00.000Z',
        payload: { kind: 'output-review', manifestDigest: '22a45970', reportPath: 'report.html' },
      },
    ],
  });
  run.output = {
    capturedAt: '2026-10-16T21:40:00.000Z',
    workerFinished: true,
    artifactManifest: [],
    manifestDigest: '22a45970',
    reportPath: 'artifacts/report.html',
  };
  run.agentContexts = [
    {
      id: 'retained-worker',
      role: 'primary',
      label: 'Worker',
      status: 'idle',
      runId: run.id,
      slotId: 'macwork-mmt-1',
      runnerSessionId: 'retained-session',
      signalAttemptId: priorSignal.attemptId,
      signalFile: '.task/fixture/SIGNAL.json',
    },
  ];
  run.steps.find((step) => step.name === S.MONITOR)!.outputs = { workerSignal: priorSignal };
  run.steps.find((step) => step.name === S.COMPLETE)!.detail =
    'A declared deterministic check has no current passing receipt.';
  const decision = await buildResultDecision(run, 'complete');
  Object.assign(run, { status: 'needs-decision', decisions: [...run.decisions, decision] });
  return run;
}

const pending = () => pendingResultDecision(run)!;

test('Accept settles an artifact-only result as a success, with its written reason', async () => {
  await heldOpus();
  const decision = pending();
  const params = { runId: run.id, decisionId: decision.id, actionId: 'accept-result' };

  await assert.rejects(resolveResultDecision(params), /needs a written reason/);
  await resolveResultDecision({ ...params, reason: 'Finding is test coverage only' });

  assert.equal(run.status, 'done');
  assert.equal(run.error, undefined, 'an accepted result settles its stop reason');
  assert.equal(run.resultDecisionReceipt?.action, 'accept-result');
  assert.equal(run.resultDecisionReceipt?.reason, 'Finding is test coverage only');
  assert.deepEqual(run.resultDecisionReceipt?.delivered, {
    headSha: '3522954d1f0b7c1f2a6c0f9d6b1e0c5a7e2d9f10',
    branch: 'feat/tat-4145-opus',
  });
  assert.equal(run.decisions[0].resolvedAction, 'accept-result');
  assert.equal(isSuccessfulRun(run), true);
  await assert.rejects(resolveResultDecision(params), /no longer pending/);
});

test('Send back needs a review round and never grants one', async () => {
  await heldOpus();
  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' }),
    /review rounds/,
  );
  assert.equal(run.status, 'needs-decision');
  assert.deepEqual(starts, []);
});

test('Send back after REVIEW resumes the fix loop from the recorded findings', async () => {
  await heldOpus(1);
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });

  assert.equal(run.status, 'reviewing');
  assert.equal(run.decisions[0].resolvedAction, 'send-back');
  assert.deepEqual(starts, [run.id]);
  const resumed = takeSendBackReview(run.id);
  assert.equal(resumed?.verdict, 'issues');
  assert.deepEqual(resumed?.issues, findings);
  assert.equal(resumed?.retryCount, 1);
  assert.equal(takeSendBackReview(run.id), undefined, 'read once');
});

test('Close of a refused completion is the named discard and is not a success', async () => {
  await heldQa();
  await assert.rejects(
    resolveResultDecision({
      runId: run.id,
      decisionId: pending().id,
      actionId: 'accept-result',
      reason: 'ok',
    }),
    /cannot be accepted/,
  );
  await resolveResultDecision({
    runId: run.id,
    decisionId: pending().id,
    actionId: 'close-result',
  });

  assert.equal(run.status, 'done');
  assert.equal(run.resultDecisionReceipt?.action, 'close-result');
  assert.equal(run.decisions[0].resolvedAction, 'close-run', 'the output review closes with it');
  assert.equal(isSuccessfulRun(run), false);
  assert.deepEqual(releases, [
    { slotId: 'macwork-mmt-1', forceReset: true, expectedRunId: run.id },
  ]);
  assert.deepEqual(idleReturns, [], 'the release itself returned the slot');
});

test('Close of a refused completion whose slot COMPLETE already released returns that checkout', async () => {
  await heldQa();
  slotStillOwned = false;
  await resolveResultDecision({
    runId: run.id,
    decisionId: pending().id,
    actionId: 'close-result',
  });
  assert.equal(releases.length, 1);
  assert.deepEqual(idleReturns, [run.id]);
});

test('Send back delivers the refusal to the retained worker and resumes only monitoring', async () => {
  await heldQa();
  const decisionId = pending().id;
  await resolveResultDecision({ runId: run.id, decisionId, actionId: 'send-back' });

  assert.deepEqual(replays, [{ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }]);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].key, `completion-send-back:${decisionId}`);
  assert.equal(feedback[0].contextId, 'retained-worker');
  assert.match(feedback[0].text, /A declared deterministic check has no current passing receipt/);
  assert.match(feedback[0].text, /new terminal signal/);
  assert.match(feedback[0].text, /\.task\/fixture\/SIGNAL.json/);
  assert.deepEqual(
    run.steps.find((step) => step.name === S.DISPATCH)?.outputs?.completionSendBackSignal,
    priorSignal,
  );
  assert.deepEqual(starts, [], 'COMPLETE is never started by the decision handler');
});

for (const stoppedAt of ['complete', 'finalize'] as const) {
  test(`a reattached publishing worker receives its exact ${stoppedAt} video refusal and note`, async () => {
    await heldQa();
    const refusal = 'Declared video is outside the selected recipe attempt.';
    run.flowType = 'dev';
    run.transport = 'tmux';
    run.completionPolicy = undefined;
    run.steps = stepsAt('dev', stoppedAt, {});
    run.steps.find((step) => step.name === stoppedAt)!.detail = refusal;
    run.agentContexts![0].role = 'dev';
    run.decisions = [await buildResultDecision(run, stoppedAt)];
    const generation = run.engineState!.generation!;
    await resolveResultDecision({
      runId: run.id,
      decisionId: pending().id,
      actionId: 'send-back',
      reason: 'Keep the accepted evidence and fix this declaration.',
    });
    assert.match(feedback[0].text, /Declared video is outside the selected recipe attempt/);
    assert.match(feedback[0].text, /Operator feedback: Keep the accepted evidence/);
    assert.equal(feedback[0].contextId, 'retained-worker');
    assert.equal(run.agentContexts![0].runnerSessionId, 'retained-session');
    assert.equal(run.engineState!.generation, generation + 1);
    assert.deepEqual(replays, [{ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }]);
  });
}

for (const outcome of ['queued', 'unconfirmed', 'not-attempted'] as const) {
  test(`completion feedback ${outcome} keeps a pending decision and never replays`, async () => {
    await heldQa();
    delivery = outcome;
    await assert.rejects(
      resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' }),
      new RegExp(`delivery is ${outcome}`),
    );
    assert.equal(run.status, 'needs-decision');
    assert.ok(pending());
    assert.deepEqual(replays, []);
    const intent = run.steps.find((step) => step.name === S.DISPATCH)?.outputs
      ?.completionSendBackDelivery;
    assert.ok(intent && typeof intent === 'object' && 'confirmed' in intent);
    assert.equal(intent.confirmed, false);
  });
}

test('a failed replay and restart reuse confirmed feedback without rejecting its saved signal', async () => {
  await heldQa();
  replayError = new Error('Frozen contract temporarily unavailable');
  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' }),
    /Frozen contract/,
  );
  const first = feedback[0];
  const dispatch = run.steps.find((step) => step.name === S.DISPATCH)!;
  dispatch.outputs = JSON.parse(JSON.stringify(dispatch.outputs));
  await representResultDecisions([run]);
  replayError = null;
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });
  assert.equal(feedback.length, 1, 'Confirmed feedback must not be sent twice');
  assert.equal(feedback[0].key, first.key);
  assert.equal(replays.length, 2);
  assert.equal(replays[1].stepName, 'monitor');
});

test('uncertain native delivery keeps its command and observes the original acceptance window', async () => {
  await heldQa();
  run.transport = 'native';
  deliveryError = new Error('Native resume acknowledgement timed out');
  await assert.rejects(
    resolveResultDecision({
      runId: run.id,
      decisionId: pending().id,
      actionId: 'send-back',
      reason: 'Keep accepted evidence.',
    }),
    /acknowledgement timed out/,
  );
  deliveryError = undefined;
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });
  assert.equal(feedback.length, 2);
  assert.equal(feedback[1].key, feedback[0].key);
  assert.equal(feedback[1].text, feedback[0].text);
  assert.equal(feedback[1].commandId, feedback[0].commandId);
  assert.equal(feedback[0].observeSince, undefined);
  assert.equal(typeof feedback[1].observeSince, 'number');
  assert.equal(replays.length, 1);
});

test('a queued instruction can continue on its next signal without moving the original floor', async () => {
  await heldQa();
  delivery = 'queued';
  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' }),
    /delivery is queued/,
  );
  currentSignal = { ...priorSignal, timestamp: '2026-10-28T00:16:01.000Z' };
  delivery = 'confirmed';
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });
  assert.equal(feedback[1].key, feedback[0].key);
  assert.deepEqual(
    run.steps.find((step) => step.name === S.DISPATCH)?.outputs?.completionSendBackSignal,
    priorSignal,
  );
  assert.equal(monitor.isWorkerSignalFreshForRun(run, currentSignal), true);
});

test('a later consumed worker signal starts a new feedback operation for another refusal', async () => {
  await heldQa();
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });
  currentSignal = { ...priorSignal, timestamp: '2026-10-28T00:16:01.000Z' };
  run.steps.find((step) => step.name === S.MONITOR)!.outputs = { workerSignal: currentSignal };
  await holdRunForResultDecision(run.id, 'complete', 'Completion refused again');
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });
  assert.equal(feedback.length, 2);
  assert.notEqual(feedback[1].key, feedback[0].key);
});

test('an unrecorded delivery confirmation reconciles its original intent on retry', async () => {
  await heldQa();
  failPersist = 'completion feedback delivered';
  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' }),
    /disk full/,
  );
  failPersist = null;
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });
  assert.equal(feedback[1].key, feedback[0].key);
  assert.equal(typeof feedback[1].observeSince, 'number');
  assert.equal(replays.length, 1);
});

test('a definitely untouched delivery retries its original command as a new send', async () => {
  await heldQa();
  delivery = 'not-attempted';
  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' }),
    /not-attempted/,
  );
  delivery = 'confirmed';
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });
  assert.equal(feedback[1].key, feedback[0].key);
  assert.equal(feedback[1].observeSince, undefined);
});

test('completion send-back refuses a foreign slot before delivering feedback', async () => {
  await heldQa();
  slotOwner = 'successor-run';
  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' }),
    /no longer owns its slot/,
  );
  assert.deepEqual(feedback, []);
  assert.deepEqual(replays, []);
  assert.equal(run.status, 'needs-decision');
});

test('a cancel during feedback delivery cannot replay or revive the run', async () => {
  await heldQa();
  afterDelivery = () => Object.assign(run, { status: 'cancelled' });
  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' }),
    /lost its retained worker or run generation/,
  );
  assert.equal(run.status, 'cancelled');
  assert.deepEqual(replays, []);
});

test('an unrecorded signal baseline cannot start monitoring or change freshness', async () => {
  await heldQa();
  failPersist = 'completion send-back signal baseline';
  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' }),
    /disk full/,
  );
  assert.equal(run.status, 'needs-decision');
  assert.ok(pending());
  assert.deepEqual(replays, []);
  assert.equal(run.steps.find((step) => step.name === S.DISPATCH)?.outputs, undefined);
});

test('an action on a replaced output snapshot is refused and the decision re-presented', async () => {
  await heldQa();
  const stale = pending();
  // A recapture with changed bytes replaced the output review.
  run.decisions[0] = {
    ...run.decisions[0],
    resolvedAt: new Date().toISOString(),
    resolvedAction: 'superseded',
  };
  run.decisions.push({
    ...run.decisions[0],
    id: 'output-review-2',
    resolvedAt: undefined,
    resolvedAction: undefined,
  });

  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: stale.id, actionId: 'close-result' }),
    /output changed/,
  );
  assert.equal(run.status, 'needs-decision');
  assert.equal(
    stale.resolvedAction ?? run.decisions.find((d) => d.id === stale.id)?.resolvedAction,
    'superseded',
  );
  assert.equal(
    (pending().payload as ResultDecisionPayload).outputReviewDecisionId,
    'output-review-2',
  );
});

test('cancel refuses a held run and names its actions', async () => {
  await heldOpus();
  await assert.rejects(
    runCancelTransitionLocked({ runId: run.id }),
    /waits for a result decision. Send it back, accept or close it/,
  );
  assert.equal(run.status, 'needs-decision');
});

test('the named discard of a held run performs Close', async () => {
  await heldQa();
  await closeDiscardedResult(run.id);

  assert.equal(run.status, 'done');
  assert.equal(run.resultDecisionReceipt?.action, 'close-result');
  assert.deepEqual(releases, [], 'the discard already released the workspace');
});

test('restart re-presents a held decision and re-projects a delivered refused completion', async () => {
  await heldOpus();
  assert.equal(restartDisposition(run), 'present-decision');
  const first = pending().id;
  await representResultDecisions([run]);
  assert.equal(run.status, 'needs-decision');
  assert.notEqual(pending().id, first, 'the decision is re-presented, never resumed');

  await heldQa();
  Object.assign(run, { status: 'failed', decisions: [run.decisions[0]] });
  assert.equal(restartDisposition(run), 'present-decision');
  await representResultDecisions([run]);
  assert.equal(run.status, 'needs-decision');
  assert.equal((pending().payload as ResultDecisionPayload).stoppedAt, 'complete');
  assert.equal(restartDisposition({ ...run, status: 'monitoring' }), 'recover');
});

test('a run held again keeps exactly one pending decision', async () => {
  await heldQa();
  const first = pending().id;
  await holdRunForResultDecision(run.id, 'complete', 'COMPLETE was refused again');

  const open = run.decisions.filter(
    (entry) => entry.payload?.kind === 'result-decision' && !entry.resolvedAt,
  );
  assert.equal(open.length, 1);
  assert.notEqual(open[0].id, first);
  assert.equal(run.decisions.find((entry) => entry.id === first)?.resolvedAction, 'superseded');
});

test('a refused completion replay leaves the run held with a fresh decision', async () => {
  await heldQa();
  const first = pending().id;
  replayError = new Error('Slot is no longer reclaimable');

  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: first, actionId: 'send-back' }),
    /no longer reclaimable/,
  );
  assert.equal(run.status, 'needs-decision');
  assert.ok(pending(), 'Close and the named discard still have a decision to act on');
  assert.notEqual(pending().id, first);
});

test('settling a REVIEW hold skips the steps that never ran', async () => {
  await heldOpus();
  await resolveResultDecision({
    runId: run.id,
    decisionId: pending().id,
    actionId: 'close-result',
  });

  assert.equal(run.steps.find((step) => step.name === S.COMPLETE)?.status, 'skipped');
  assert.equal(
    run.steps.some((step) => step.status === 'pending'),
    false,
  );
});

test('a held run is not a failure in analytics, even after a failed record', async () => {
  await heldQa();
  const failed = buildAnalyticsRecord({ ...run, status: 'failed' });
  assert.equal(failed.failedStep, S.COMPLETE, 'the restart re-projects this earlier record');
  const held = buildAnalyticsRecord(run);
  assert.equal(held.failedStep, null);
  assert.equal(held.failureReason, null);

  const result = aggregateAnalytics([failed, held], {}, '2026-10-19T00:00:00.000Z');
  assert.deepEqual(result.failureByStep, {});
  assert.deepEqual(result.failureByReason, {});
});

test('restart re-projection replaces the failure record, and the next result is recorded', async () => {
  await heldQa();
  // 3e2f400a as main left it: failed, its failure record already written.
  Object.assign(run, {
    status: 'failed',
    decisions: [run.decisions[0]],
    analyticsEmittedAt: '2026-10-17T01:21:00.000Z',
  });
  await appendAnalyticsRecord(buildAnalyticsRecord(run));
  const at = '2026-10-19T00:00:00.000Z';

  await representResultDecisions([run]);

  assert.equal(run.status, 'needs-decision');
  assert.equal(run.analyticsEmittedAt, undefined);
  let { records } = await readAllAnalyticsRecords();
  assert.deepEqual(aggregateAnalytics(records, {}, at).failureByStep, {});

  // The monitor double models the later worker completion for this analytics check.
  onReplay = () =>
    Object.assign(run, { status: 'done', metrics: { ...run.metrics, outcome: 'success' } });
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });
  const emitted = emitAnalyticsForTerminalRun(run);
  assert.ok(emitted, 'the terminal record is emitted again');
  await emitted;

  ({ records } = await readAllAnalyticsRecords());
  const result = aggregateAnalytics(records, {}, at);
  assert.deepEqual(result.byStatus, { done: 1 });
  assert.equal(isSuccessfulRun(run), true);
});

test('the decision states why the run stopped in one line', async () => {
  await heldOpus();
  assert.equal(pending().payload.reason, 'Review found 1 issue after 1/2 fix attempts.');
  await heldQa();
  assert.equal(pending().payload.reason, 'COMPLETE was refused.');
});

test('restart holds again a run a cut-short completion send-back left without a decision', async () => {
  await heldQa();
  Object.assign(run, {
    decisions: run.decisions.map((entry) =>
      entry.payload?.kind === 'result-decision'
        ? { ...entry, resolvedAt: '2026-10-19T00:00:00.000Z', resolvedAction: 'send-back' }
        : entry,
    ),
  });
  assert.equal(pending(), undefined);

  await representResultDecisions([run]);

  assert.equal(run.status, 'needs-decision');
  assert.equal(pending().payload.stoppedAt, 'complete');
});

test('a send-back whose replay and re-hold both fail reports both', async () => {
  await heldQa();
  replayError = new Error('Slot is no longer reclaimable');
  failPersist = 'held for a result decision';

  await assert.rejects(
    resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' }),
    (error: unknown) =>
      error instanceof AggregateError &&
      /no longer reclaimable\. The run could not be held again: disk full/.test(error.message),
  );
  assert.equal(run.status, 'needs-decision');
});

test('a re-projected run with no earlier record appends nothing', async () => {
  await heldQa();
  Object.assign(run, { id: 'no-record-run', status: 'failed', decisions: [run.decisions[0]] });
  const before = (await readAllAnalyticsRecords()).records.length;

  await representResultDecisions([run]);

  assert.equal(run.status, 'needs-decision');
  assert.equal((await readAllAnalyticsRecords()).records.length, before);
});

test('a review whose fix never reached the worker says why in its decision', async () => {
  // TAT-4006 7721a02b: the worker's runner was out of quota when the fix was due.
  const quota =
    'Runner out of quota: grok hit a usage/rate limit — the composer will not accept prompts until the limit resets. Fix delivery and the relaunch stopped (REVIEW-FIX.md).';
  await heldOpus();
  const review = run.steps.find((step) => step.name === S.REVIEW)!;
  review.outputs = { ...review.outputs, fixDeliveryFailure: quota };
  run.decisions = [await buildResultDecision(run, 'review')];
  assert.equal(
    pending().payload.reason,
    `Review found 1 issue after 1/2 fix attempts. The fix was not delivered: ${quota}`,
  );
});

test('Send back resumes a recovered undelivered fix from the original reviewed head without output capture', async () => {
  await heldOpus(1);
  const originalSnapshot = {
    source: 'local-git' as const,
    headSha: '3522954d1f0b7c1f2a6c0f9d6b1e0c5a7e2d9f10',
    capturedAt: '2026-10-29T19:01:00Z',
  };
  run.steps.find((step) => step.name === S.REVIEW)!.outputs!.reviewSnapshot = originalSnapshot;
  run.output = undefined;
  const { undeliveredReviewFixResult } = await import('../review/orchestrator.js');
  const recovered = await undeliveredReviewFixResult({
    result: { verdict: 'blocked', issues: findings, reviewId: 'pipeline-review-1' },
    reason: 'Recovered fix prompt remained unconfirmed',
    run,
    attempts: [],
    retryCount: 1,
    maxRetries: 2,
    start: Date.now(),
  });
  run.steps.find((step) => step.name === S.REVIEW)!.outputs = { ...recovered };
  run.decisions = [await buildResultDecision(run, 'review')];
  const delivered = pending().payload.delivered;
  assert.ok('headSha' in delivered);
  assert.equal(delivered.headSha, originalSnapshot.headSha);
  assert.ok(pending().payload.actions.find((action) => action.id === 'send-back')?.available);
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });
  const resumed = takeSendBackReview(run.id);
  assert.equal(resumed?.verdict, 'issues');
  assert.deepEqual(resumed?.issues, findings);
  assert.deepEqual(resumed?.reviewSnapshot, originalSnapshot);
  assert.equal(resumed?.feedbackSent, false);
  assert.deepEqual(starts, [run.id]);
  assert.deepEqual(releases, []);
});
