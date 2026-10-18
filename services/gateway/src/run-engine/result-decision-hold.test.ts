// ADR-065 Amendment 7: a delivered result that review or a completion
// prerequisite did not accept waits in `needs-decision` instead of `failed`.
// Driven through the real engine with the states of runs 8cff6e80 and 3e2f400a.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  FLOW_STEPS,
  type PipelineStep,
  PipelineSteps as S,
  type ResultDecisionPayload,
  type Run,
  type RunStep,
} from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from './test-fixtures.js';

let run: Run;
const opusFindings = [
  {
    file: 'src/features/perpetuals/queries/invalidate-live-trading-queries.ts',
    line: 31,
    description: 'No test covers the marginModeLock invalidation AC2 rests on.',
  },
  {
    file: 'temp/tasks/feat/tat-4145-opus-1018-135546/artifacts/pr-description.md',
    line: 3,
    description:
      'DIFF_CHANGE_NOT_DESCRIBED: useOrderMarginMode.ts:48-50 never offers Cross in the desktop app.',
  },
];
const refusalReasons = [
  {
    code: 'deterministic-not-passed' as const,
    prerequisite: 'deterministic' as const,
    message: 'A declared deterministic check has no current passing receipt.',
    actionId: 'hold' as const,
  },
  {
    code: 'evidence-policy-unsatisfied' as const,
    prerequisite: 'evidence' as const,
    evidencePolicy: 'claim-verdict' as const,
    message: 'Recorded claim verdicts do not satisfy publication policy.',
    actionId: 'hold' as const,
  },
  {
    code: 'run-progress-unconfirmed' as const,
    prerequisite: 'lifecycle' as const,
    message: 'The current runner operation cannot be confirmed idle.',
    actionId: 'hold' as const,
  },
];
let failHoldPersist = false;

mock.module('./post-dispatch-steps.js', {
  namedExports: {
    executeReviewStep: async () => {
      // REVIEW of 8cff6e80: 2 issues after 1/2 fix attempts, all 5 rounds spent.
      const { ResultDecisionHoldError } = await import('../run-completion/result-decision.js');
      throw new ResultDecisionHoldError(
        'Review found 2 issue(s) after 1/2 fix attempts in src/features/perpetuals/queries/invalidate-live-trading-queries.ts:31: No test covers the marginModeLock invalidation AC2 rests on.',
        { validationDepth: 'full-live' },
        {
          verdict: 'issues',
          issues: opusFindings,
          retryCount: 1,
          maxRetries: 2,
          maxRetriesExhausted: true,
          reviewSnapshot: { headSha: '3522954595facf528417ec6dfa65fd83d2aba02e' },
        },
      );
    },
    executeCompleteStep: async () => {
      // COMPLETE of 3e2f400a: the deterministic check has no passing receipt.
      const { RunGateNotReadyError } = await import('./gate-prerequisites.js');
      throw new RunGateNotReadyError(
        { state: 'not-ready', identity: { runId: run.id, generation: 5 }, reasons: refusalReasons },
        refusalReasons,
      );
    },
    executeMonitorStep: async () => {
      throw new Error('Unexpected monitor');
    },
    executeHumanGateStep: async () => ({ inputs: {}, outputs: { skipped: true } }),
    holdInteractiveCompletionForOperator: () => {
      throw new Error('Unexpected hold');
    },
    isFlowTerminalStep: () => false,
    readyGateReviewSubjectMatches: () => false,
    persistedUpdateBranchNeedsReview: () => false,
    shouldSkipRetrospectiveAtComplete: () => true,
    baseReviewPolicy: () => 'full-live',
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
    persistRunNow: async (_run: Run, reason: string) => {
      if (failHoldPersist && reason === 'held for a result decision') throw new Error('disk full');
    },
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
const { startRun } = await import('./orchestrator.js');

function delivered(flowType: Run['flowType'], status: Run['status'], at: PipelineStep): Run {
  const steps = FLOW_STEPS[flowType];
  return makeRun({
    flowType,
    mode: 'autonomous',
    status,
    slotId: null,
    completionPolicy: 'artifact-only',
    engineState: { generation: 1 },
    steps: steps.map((name, index) => ({
      name,
      status: index < steps.indexOf(at) ? 'done' : name === at ? 'running' : 'pending',
      ...(name === S.MONITOR
        ? {
            outputs: {
              workerSignal: { status: 'complete' },
              pushVerification: { verified: true, dirtyFiles: 0, unpushedCommits: 1 },
            },
          }
        : {}),
    })),
  });
}

function heldPayload(): ResultDecisionPayload {
  const decision = run.decisions.find((entry) => entry.payload?.kind === 'result-decision');
  assert.ok(decision, 'a result decision is pending');
  assert.equal(decision.resolvedAt, undefined);
  assert.equal(decision.type, 'engine_result_decision');
  return decision.payload as ResultDecisionPayload;
}

const action = (payload: ResultDecisionPayload, id: string) =>
  payload.actions.find((entry) => entry.id === id)!;

test('8cff6e80: review findings on a pushed comparison result need a decision, not failed', async () => {
  run = {
    ...delivered('dev', 'reviewing', S.REVIEW),
    id: '8cff6e80-6b53-44a0-9834-9f0a44631aad',
    lane: 'comparison',
    branch: 'feat/tat-4145-opus',
    reviewRoundAdmissions: Array.from({ length: 5 }, (_, i) => `admission-${i}`),
    output: {
      capturedAt: '2026-10-18T10:50:00.000Z',
      workerFinished: false,
      artifactManifest: [],
      manifestDigest: '9bbbd8fd973fb29c2afd3757f74bd0324d8d8c8070a0135fe0e5c8ba73425cfe',
      reportPath: 'artifacts/pr-description.md',
    },
  };

  await startRun(run.id);

  assert.equal(run.status, 'needs-decision');
  assert.match(run.error ?? '', /^Review found 2 issue\(s\) after 1\/2 fix attempts/);
  assert.equal(run.steps.find((step) => step.name === S.REVIEW)?.status, 'failed');
  assert.equal(run.steps.find((step) => step.name === S.COMPLETE)?.status, 'pending');
  const payload = heldPayload();
  assert.equal(payload.stoppedAt, 'review');
  assert.equal(payload.reason, 'Review found 2 issues after 1/2 fix attempts.');
  assert.deepEqual(payload.findings, opusFindings);
  assert.deepEqual(payload.delivered, {
    headSha: '3522954595facf528417ec6dfa65fd83d2aba02e',
    branch: 'feat/tat-4145-opus',
  });
  assert.equal(action(payload, 'send-back').available, false, 'all review rounds are spent');
  assert.match(action(payload, 'send-back').unavailableReason ?? '', /review rounds/);
  assert.equal(action(payload, 'accept-result').available, true);
  assert.equal(action(payload, 'accept-result').requiresReason, true);
  assert.equal(action(payload, 'close-result').available, true);
});

function qaRun(output: Run['output']): Run {
  return {
    ...delivered('qa', 'completing', S.COMPLETE),
    id: '3e2f400a-2e87-409e-92e6-2557c5dfbc8a',
    lane: 'production',
    output,
    decisions: [
      {
        id: 'output-review-1',
        type: 'engine_output_review',
        title: 'Review run output',
        description: 'Review the captured report',
        actions: [
          { id: 'mark-reviewed', label: 'Mark reviewed', style: 'primary' },
          { id: 'close-run', label: 'Close run', style: 'secondary' },
        ],
        createdAt: '2026-10-16T21:40:00.000Z',
        payload: {
          kind: 'output-review',
          manifestDigest: '22a459709567397a8346c40c15cc33ac6c230257999bb32b17dd53a84a0266fe',
          reportPath: 'artifacts/report.html',
        },
      },
    ],
  };
}

const qaOutput: NonNullable<Run['output']> = {
  capturedAt: '2026-10-16T21:40:00.000Z',
  workerFinished: true,
  artifactManifest: [],
  manifestDigest: '22a459709567397a8346c40c15cc33ac6c230257999bb32b17dd53a84a0266fe',
  reportPath: 'artifacts/report.html',
};

test('3e2f400a: a refused QA completion with a captured report needs a decision', async () => {
  run = qaRun(qaOutput);

  await startRun(run.id);

  assert.equal(run.status, 'needs-decision');
  const complete = run.steps.find((step) => step.name === S.COMPLETE)!;
  assert.equal(complete.status, 'failed');
  assert.ok(complete.outputs?.gatePrerequisiteRefusal, 'Amendment 6 keeps the refusal record');
  const payload = heldPayload();
  assert.equal(payload.stoppedAt, 'complete');
  assert.equal(payload.reason, 'COMPLETE was refused: 3 prerequisites not met.');
  assert.deepEqual(payload.refusal?.reasons, refusalReasons);
  assert.deepEqual(payload.delivered, {
    reportPath: 'artifacts/report.html',
    manifestDigest: qaOutput.manifestDigest,
  });
  assert.equal(payload.outputReviewDecisionId, 'output-review-1');
  assert.equal(action(payload, 'send-back').available, true, 'the completion replay');
  assert.equal(action(payload, 'accept-result').available, false);
  assert.equal(action(payload, 'close-result').available, true);
});

test('a refused completion without a delivered result stays failed (Amendment 6)', async () => {
  run = qaRun({ ...qaOutput, captureError: 'Artifact mirror unavailable' });

  await startRun(run.id);

  assert.equal(run.status, 'failed');
  assert.equal(
    run.decisions.some((entry) => entry.payload?.kind === 'result-decision'),
    false,
  );
});

test('a hold that cannot be recorded fails the run instead of leaving it completing', async () => {
  run = qaRun(qaOutput);
  failHoldPersist = true;
  try {
    await startRun(run.id);
  } finally {
    failHoldPersist = false;
  }

  assert.equal(run.status, 'failed', 'Amendment 6 settles it');
  assert.equal(
    run.decisions.some((entry) => entry.payload?.kind === 'result-decision'),
    false,
    'no decision is left pending on a failed run',
  );
});
