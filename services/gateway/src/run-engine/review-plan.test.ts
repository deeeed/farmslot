import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reviewPolicySatisfied,
  type ReviewSelection,
  type ReviewStatus,
  type RunDecision,
} from '@farmslot/protocol';

import {
  automaticPublicationReviewPlan,
  humanGateReviewPolicy,
  remainingExplicitReviewPlan,
  resolveHumanGateReviewExecutionPlan,
  reviewPlanFromSelection,
} from './review-plan.js';

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
