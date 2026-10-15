import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reviewPolicySatisfied,
  type ReviewSelection,
  type ReviewStatus,
  type RunDecision,
} from '@farmslot/protocol';
import {
  resolveReviewDispatchDefaults,
  reviewRequestFromSequence,
} from '@farmslot/review-dispatch';

import {
  registerWarmReviewerSession,
  resetWarmReviewerSessionsForTest,
} from '../review/session-mode.js';

import {
  automaticPublicationReviewPlan,
  humanGateReviewPolicy,
  recoveryReviewPlanForActiveFix,
  remainingExplicitReviewPlan,
  repairUnboundRecoveryReviewPlan,
  resolveHumanGateReviewExecutionPlan,
  reviewPlanFromSelection,
} from './review-plan.js';
import { makeRun } from './test-fixtures.js';

test('complete replay repairs an unbound warm row from its original pair and current-head PASS', () => {
  const head = 'a'.repeat(40);
  const plan: ReviewSelection[] = [
    { runner: 'claude', model: 'opus', effort: null, mode: 'cold' },
    { runner: 'codex', model: 'gpt-6-astra', effort: 'high', mode: 'cold' },
  ];
  const run = makeRun({
    decisions: [
      {
        id: 'original-pair',
        type: 'engine_human_gate',
        title: 'Review',
        description: '',
        actions: [],
        createdAt: '2026-10-15T00:00:00Z',
        resolvedAt: '2026-10-15T00:00:01Z',
        resolvedAction: 'request-review',
        context: { reviewRequestConsumedAt: '2026-10-15T00:00:02Z' },
        selectionData: { reviewRequest: reviewRequestFromSequence(plan) },
      },
    ],
    reviewRoundAdmissions: Array.from({ length: 7 }, (_, index) => `spent-${index}`),
    engineState: {
      publishGate: {
        reviewSequence: [{ ...plan[0], mode: 'warm' }],
        reviewSequenceRequestedAt: '2026-10-15T00:02:00Z',
        reviews: [
          {
            ...passing('native-pass', 'native-session', 'human-gate'),
            runner: 'claude',
            model: 'opus',
            effort: null,
            reviewedHeadSha: head,
            completedAt: '2026-10-15T00:01:00Z',
          },
        ],
      },
    },
  });
  run.reviewRoundAdmissions = Array.from({ length: 7 }, (_, index) => `spent-${index}`);
  const before = structuredClone(run);
  const repaired = repairUnboundRecoveryReviewPlan(run, head);
  assert.deepEqual(repaired?.sequence, [plan[1]]);
  assert.equal(repaired?.requestedAt, run.decisions[0].resolvedAt);
  assert.match(repaired?.note ?? '', /original gate request/);
  assert.deepEqual(
    run,
    before,
    'repair does not consume another admission or rewrite native proof',
  );
  assert.deepEqual(
    repairUnboundRecoveryReviewPlan(run, 'b'.repeat(40))?.sequence,
    plan,
    'a different-head PASS cannot satisfy the recovered request',
  );
  const fallback = repairUnboundRecoveryReviewPlan({ ...run, decisions: [] }, head);
  assert.deepEqual(fallback?.sequence, [plan[0]]);
  assert.match(fallback?.note ?? '', /Using COLD/);
});

test('active fix recovery binds verified warm lineage, otherwise records a cold fallback', (t) => {
  resetWarmReviewerSessionsForTest();
  t.after(resetWarmReviewerSessionsForTest);
  const run = makeRun({
    ticketOrPr: 'example/recovery#42',
    engineState: {
      publishGate: {
        reviews: [
          {
            ...passing('lineage', 'retained-session', 'human-gate'),
            verdict: 'issues',
            unresolvedCount: 1,
          },
        ],
      },
    },
  });
  run.agentContexts = [
    {
      id: 'review-fix',
      role: 'review-fix',
      label: 'Fix',
      status: 'working',
      slotId: 'slot-1',
      runId: 'run-1',
    },
    {
      id: 'reviewer',
      role: 'review',
      label: 'Reviewer',
      status: 'complete',
      slotId: 'slot-1',
      runId: 'run-1',
      runner: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      runnerSessionId: 'retained-session',
    },
  ];
  assert.equal(recoveryReviewPlanForActiveFix(run)?.sequence[0].mode, 'cold');
  assert.match(recoveryReviewPlanForActiveFix(run)?.note ?? '', /Using COLD/);
  registerWarmReviewerSession({
    runId: run.id,
    reviewId: 'lineage',
    project: run.project,
    ownerPrincipalId: null,
    transport: 'tmux',
    taskDir: '',
    artifactScope: 'lineage',
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    repository: 'example/recovery',
    prNumber: 42,
    contextId: 'reviewer',
    windowName: 'reviewer',
    slotId: 'slot-1',
    runnerSessionId: 'retained-session',
    runnerSessionPath: '/tmp/retained-session.jsonl',
    lastLoopNumber: 1,
    lastReviewedHeadSha: 'head',
  });
  const recovered = recoveryReviewPlanForActiveFix(run);
  assert.equal(recovered?.sequence[0].mode, 'warm');
  assert.deepEqual(recovered?.context, {
    reviewLineages: [{ repository: 'example/recovery', prNumber: 42, reviewId: 'lineage' }],
  });
  run.engineState!.publishGate!.reviews![0].verdict = 'pass';
  assert.equal(
    recoveryReviewPlanForActiveFix(run),
    undefined,
    'a stale active fix cannot replace remaining reviewers after PASS',
  );
});

const selection: ReviewSelection = {
  runner: 'codex',
  model: 'gpt-6-astra',
  effort: 'high',
  mode: 'cold' as const,
};
function passing(
  id: string,
  session: string,
  source: ReviewStatus['source'] = 'pipeline',
): ReviewStatus {
  return {
    id,
    source,
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    mode: 'cold' as const,
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    reviewerSessionId: session,
    reviewedHeadSha: 'head',
    completedAt: '2026-10-11T01:00:00Z',
  };
}

test('gate payload round trips effort and ordered remaining selections', () => {
  const second = {
    ...selection,
    runner: 'claude',
    model: null,
    effort: null,
    mode: 'warm' as const,
  };
  assert.deepEqual(
    reviewPlanFromSelection({ reviewRequest: { ...selection, sequence: [second] } }),
    [selection, second],
  );
  assert.throws(() => reviewPlanFromSelection({ reviewRequest: { runner: 'same' } }));
  assert.throws(() => reviewPlanFromSelection({ reviewRequest: { ...selection, loops: [] } }));
});

test('pipeline review satisfies the policy regardless of worker runner', () => {
  const review = passing('pipeline-review-1', 'session-1');
  const policy = { minimumReviews: 1, requestedBy: 'dispatch' as const };
  assert.equal(reviewPolicySatisfied(policy, [review]), true);
  assert.deepEqual(automaticPublicationReviewPlan(policy, [review]), []);
});

test('automatic publication review accepts pack policy fields without an explicit plan', () => {
  const project = {
    name: 'app',
    defaults: { 'review-pr': { runner: 'codex', model: 'gpt-6-astra' } },
    review: {
      enabled: true,
      max_retries: 2,
      review_timeout_min: 15,
      runner: 'claude',
      model: 'sonnet',
      mode: 'cold' as const,
    },
  };
  assert.deepEqual(
    automaticPublicationReviewPlan(
      { minimumReviews: 2, requestedBy: 'dispatch' },
      [passing('one', 'session-1')],
      resolveReviewDispatchDefaults(project, 'review-pr'),
    ),
    [{ runner: 'claude', model: 'sonnet', effort: null, mode: 'cold' }],
  );
});

test('rechecks of one session consume one required reviewer', () => {
  const policy = { minimumReviews: 2, requestedBy: 'dispatch' as const };
  assert.equal(
    reviewPolicySatisfied(policy, [passing('one', 'session-1'), passing('recheck', 'session-1')]),
    false,
  );
  assert.equal(automaticPublicationReviewPlan(policy, [passing('one', 'session-1')]).length, 1);
  assert.equal(
    reviewPolicySatisfied(policy, [passing('one', 'session-1'), passing('two', 'session-2')]),
    true,
  );
});

test('historical records lacking session or reviewed head cannot satisfy publication', () => {
  const policy = { minimumReviews: 1, requestedBy: 'dispatch' as const };
  assert.equal(
    reviewPolicySatisfied(policy, [{ ...passing('one', 'session-1'), reviewerSessionId: null }]),
    false,
  );
  assert.equal(
    reviewPolicySatisfied(policy, [{ ...passing('one', 'session-1'), reviewedHeadSha: undefined }]),
    false,
  );
});

test('explicit sequence matches each session only once and preserves order', () => {
  assert.deepEqual(
    remainingExplicitReviewPlan(
      [selection, selection],
      [passing('one', 'session-1'), passing('retry', 'session-1')],
    ),
    [selection],
  );
});

test('latest gate selection overrides stale pending work', () => {
  const decisions: RunDecision[] = [
    {
      id: 'request',
      type: 'engine_human_gate',
      title: '',
      description: '',
      actions: [],
      createdAt: '',
      resolvedAt: '2026-10-11T01:00:00Z',
      resolvedAction: 'request-review',
      selectionData: { reviewRequest: selection },
    },
  ];
  assert.deepEqual(
    resolveHumanGateReviewExecutionPlan({
      gateAction: 'request-review',
      pendingPlan: [{ ...selection, runner: 'claude' }],
      decisions,
    }),
    [selection],
  );
  assert.deepEqual(
    humanGateReviewPolicy(
      { minimumReviews: 0, requestedBy: 'dispatch' },
      { ...selection, sequence: [selection] },
    ),
    { minimumReviews: 2, requestedBy: 'human-gate' },
  );
});

test('a later recheck failure replaces its earlier passing session result', () => {
  const review = passing('one', 'session-1');
  assert.equal(
    reviewPolicySatisfied({ minimumReviews: 1, requestedBy: 'dispatch' }, [
      review,
      { ...review, verdict: 'issues', unresolvedCount: 1 },
    ]),
    false,
  );
});

test('WARM preflight refuses unbound or foreign lineage without changing the requested mode', async () => {
  const { assertWarmReviewRequestAvailable, assertPrimaryReviewContext } =
    await import('./review-plan.js');
  const { makeRun } = await import('./test-fixtures.js');
  const run = makeRun({ flowType: 'review-pr', ticketOrPr: 'owner/repo#42' });
  const request = { ...selection, mode: 'warm' as const };
  assert.throws(() => assertWarmReviewRequestAvailable(run, request, []), /WARM.*lineage/);
  assert.throws(
    () =>
      assertWarmReviewRequestAvailable(
        run,
        {
          ...request,
          context: {
            reviewLineages: [{ repository: 'owner/foreign', prNumber: 42, reviewId: 'review-1' }],
          },
        },
        [],
      ),
    /different repository\/PR/,
  );
  assert.throws(
    () => assertPrimaryReviewContext({ ...run, reviewMode: 'warm' }),
    /explicit reviewId lineage/,
  );
  assert.equal(request.mode, 'warm');
});

test('fresh-session rechecks of one lineage still count only its latest result', () => {
  const policy = { minimumReviews: 2, requestedBy: 'dispatch' as const };
  assert.equal(
    reviewPolicySatisfied(policy, [passing('one', 'session-1'), passing('one', 'session-2')]),
    false,
  );
  assert.equal(
    reviewPolicySatisfied({ ...policy, minimumReviews: 1 }, [
      passing('one', 'session-1'),
      { ...passing('one', 'session-2'), verdict: 'issues', unresolvedCount: 1 },
    ]),
    false,
  );
});
