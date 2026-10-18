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
  type PipelineStep,
  PipelineSteps as S,
  type ResultDecisionPayload,
  type Run,
  type RunReplayStepParams,
  type RunStep,
  type SlotReleaseParams,
} from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from '../run-engine/test-fixtures.js';

let run: Run;
let replays: RunReplayStepParams[] = [];
let releases: SlotReleaseParams[] = [];
let starts: string[] = [];
let replayError: Error | null = null;
let onReplay: (() => void) | null = null;
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
    persistRunNow: async () => undefined,
  },
});
mock.module('../server.js', { namedExports: { broadcastEvent: () => {} } });
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
  },
});
const release = await import('../methods/slot/release.js');
mock.module('../methods/slot/release.js', {
  namedExports: {
    ...release,
    slotRelease: async (params: SlotReleaseParams) => {
      releases.push(params);
      return { released: true };
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
  replayError = null;
  onReplay = null;
  replays = [];
  releases = [];
  starts = [];
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
  const decision = await buildResultDecision(run, 'review', 'Review found 1 issue(s)');
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
  run.steps.find((step) => step.name === S.COMPLETE)!.detail =
    'A declared deterministic check has no current passing receipt.';
  const decision = await buildResultDecision(run, 'complete', 'COMPLETE was refused');
  Object.assign(run, { status: 'needs-decision', decisions: [...run.decisions, decision] });
  return run;
}

const pending = () =>
  run.decisions.find((entry) => entry.payload?.kind === 'result-decision' && !entry.resolvedAt)!;

test('Accept settles an artifact-only result as a success, with its written reason', async () => {
  await heldOpus();
  const decision = pending();
  const params = { runId: run.id, decisionId: decision.id, actionId: 'accept-result' };

  await assert.rejects(resolveResultDecision(params), /needs a written reason/);
  await resolveResultDecision({ ...params, reason: 'Finding is test coverage only' });

  assert.equal(run.status, 'done');
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
});

test('Send back of a refused completion is its completion replay', async () => {
  await heldQa();
  await resolveResultDecision({ runId: run.id, decisionId: pending().id, actionId: 'send-back' });

  assert.deepEqual(replays, [{ runId: run.id, stepName: 'complete' }]);
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

  // Send back replays COMPLETE, which now passes.
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
