import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveRunLifecycleView,
  hasDeliveredResult,
  isActiveListRun,
  isHeldForResultDecision,
  isSuccessfulRun,
  refusedCompletionStep,
  type ResultDecisionReceipt,
  type Run,
  type RunMetrics,
  type RunStep,
} from '../../src/index.js';

type Delivered = Pick<Run, 'steps' | 'output'>;

// TAT-4145 run 8cff6e80: a comparison dev run whose worker pushed its branch,
// then review found 2 issues once no further fix could run.
function opusComparison(): Delivered {
  return {
    steps: [
      {
        name: 'monitor',
        status: 'done',
        outputs: {
          workerSignal: { status: 'complete' },
          pushVerification: { verified: true, dirtyFiles: 0, unpushedCommits: 1 },
        },
      },
      { name: 'review', status: 'failed', outputs: { maxRetriesExhausted: true } },
    ],
    output: {
      capturedAt: '2026-10-18T10:50:00.000Z',
      workerFinished: false,
      artifactManifest: [],
      manifestDigest: '9bbbd8fd973fb29c2afd3757f74bd0324d8d8c8070a0135fe0e5c8ba73425cfe',
      reportPath: 'artifacts/pr-description.md',
    },
  };
}

// Run 3e2f400a: a production QA run whose COMPLETE prerequisite was refused.
const refusedComplete: RunStep = {
  name: 'complete',
  status: 'failed',
  outputs: { gatePrerequisiteRefusal: { readiness: { state: 'not-ready', reasons: [] } } },
};

test('a delivered result is a done signal, a verified push where required, and a captured output', () => {
  const run = opusComparison();
  assert.equal(hasDeliveredResult(run, 'push'), true);

  const unverified = opusComparison();
  unverified.steps[0].outputs!.pushVerification = { verified: false };
  assert.equal(hasDeliveredResult(unverified, 'push'), false);
  assert.equal(hasDeliveredResult(unverified, 'none'), true, 'QA needs no push');

  const blocked = opusComparison();
  blocked.steps[0].outputs!.workerSignal = { status: 'blocked' };
  assert.equal(hasDeliveredResult(blocked, 'push'), false);

  const uncaptured = opusComparison();
  uncaptured.output = { ...uncaptured.output!, captureError: 'mirror unreachable' };
  assert.equal(hasDeliveredResult(uncaptured, 'push'), false);
  assert.equal(hasDeliveredResult({ ...opusComparison(), output: undefined }, 'push'), false);
});

test('a run held for a result decision is active, not working, and labelled for a person', () => {
  const held = { status: 'needs-decision' as const, steps: [refusedComplete] };
  assert.equal(isHeldForResultDecision(held), true);
  assert.equal(isHeldForResultDecision({ status: 'failed' }), false);
  assert.equal(isActiveListRun(held), true);
  assert.equal(refusedCompletionStep(held), refusedComplete, 'Amendment 6 guards still find it');

  const view = deriveRunLifecycleView({ status: 'needs-decision' });
  assert.equal(view.label, 'Needs decision');
  assert.equal(view.tone, 'warn');
  assert.equal(view.canAdvance, false);
});

test('an accepted result succeeds and a closed one does not, whatever the worker outcome', () => {
  const receipt = (action: ResultDecisionReceipt['action']): ResultDecisionReceipt => ({
    action,
    principalId: 'arthur',
    decidedAt: '2026-10-18T12:00:00.000Z',
    delivered: { headSha: '3522954', branch: 'feat/tat-4145-opus' },
    findingsDigest: 'sha256:findings',
  });
  const done = { status: 'done' as const };
  const metrics = (outcome?: RunMetrics['outcome']): RunMetrics => ({
    nudgeCount: 0,
    model: null,
    runner: null,
    ...(outcome ? { outcome } : {}),
  });
  assert.equal(
    isSuccessfulRun({
      ...done,
      metrics: metrics('failure'),
      resultDecisionReceipt: receipt('accept-result'),
    }),
    true,
  );
  assert.equal(
    isSuccessfulRun({
      ...done,
      metrics: metrics('success'),
      resultDecisionReceipt: receipt('close-result'),
    }),
    false,
  );
  assert.equal(
    isSuccessfulRun({
      status: 'needs-decision',
      metrics: metrics(),
      resultDecisionReceipt: receipt('send-back'),
    }),
    false,
  );
  assert.equal(isSuccessfulRun({ ...done, metrics: metrics('success') }), true);
});
