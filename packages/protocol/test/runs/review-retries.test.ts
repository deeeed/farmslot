import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewAttempt } from '../../src/contracts/runs.js';
import {
  latestExhaustedReview,
  MAX_UPDATE_BRANCH_REVIEW_ROUNDS,
  REVIEW_NO_VERDICT_LIMIT,
  reviewFixRetriesExhausted,
  reviewRetryCapReason,
  reviewRetryCount,
  reviewRoundBudget,
  reviewRoundBudgetLabel,
  stampReviewRetryCap,
} from '../../src/runs/review-retries.js';

const attempt = (extras: Partial<ReviewAttempt> = {}): ReviewAttempt => ({
  mode: 'cold',
  loopNumber: 1,
  verdict: 'issues',
  unresolvedCount: 1,
  ...extras,
});

test('retry count prefers the persisted field then falls back to attempts', () => {
  assert.equal(
    reviewRetryCount({
      retryCount: 3,
      attempts: [attempt(), attempt(), attempt(), attempt()],
    }),
    3,
  );
  assert.equal(reviewRetryCount({ attempts: [attempt(), attempt(), attempt(), attempt()] }), 3);
  assert.equal(reviewRetryCount({}), 0);
  assert.equal(
    reviewRetryCount({
      retryCount: 0,
      attempts: [attempt(), attempt(), attempt(), attempt()],
    }),
    3,
    'a wiped retryCount: 0 must not hide spent attempts',
  );
});

test('stamp repairs a wiped cap so a spent extra-review is exhausted', () => {
  const stamped = stampReviewRetryCap(
    {
      source: 'human-gate',
      verdict: 'issues',
      unresolvedCount: 7,
      retryCount: 0,
      recoveryContinuationPending: true,
      attempts: [attempt(), attempt(), attempt(), attempt()],
    },
    3,
  );
  assert.equal(stamped.retryCount, 3);
  assert.equal(stamped.maxRetries, 3);
  assert.equal(stamped.maxRetriesExhausted, true);
  assert.equal(stamped.recoveryContinuationPending, false);
});

test('explicit maxRetriesExhausted wins', () => {
  assert.equal(
    reviewFixRetriesExhausted({
      source: 'human-gate',
      verdict: 'issues',
      unresolvedCount: 2,
      maxRetriesExhausted: true,
    }),
    true,
  );
});

test('compares retryCount to maxRetries when both are known', () => {
  const base = {
    source: 'human-gate' as const,
    verdict: 'issues' as const,
    unresolvedCount: 6,
    retryCount: 3,
    maxRetries: 3,
  };
  assert.equal(reviewFixRetriesExhausted(base), true);
  assert.equal(reviewFixRetriesExhausted({ ...base, retryCount: 2 }), false);
  assert.equal(
    reviewFixRetriesExhausted({
      ...base,
      retryCount: 2,
      maxRetriesExhausted: true,
    }),
    true,
  );
});

test('max_retries 0 is not a cap-hit; missing maxRetries is not inferred', () => {
  assert.equal(
    reviewFixRetriesExhausted({
      source: 'human-gate',
      verdict: 'issues',
      unresolvedCount: 6,
      retryCount: 0,
      maxRetries: 0,
    }),
    false,
  );
  assert.equal(
    reviewFixRetriesExhausted({
      source: 'human-gate',
      verdict: 'issues',
      unresolvedCount: 6,
      feedbackSent: false,
      recoveryContinuationPending: true,
      attempts: [attempt(), attempt(), attempt(), attempt()],
    }),
    false,
  );
});

test('only the latest extra-review on the current package can be exhausted', () => {
  const oldCap = {
    source: 'human-gate' as const,
    verdict: 'issues' as const,
    unresolvedCount: 4,
    retryCount: 3,
    maxRetries: 3,
    reviewedHeadSha: 'old',
  };
  const laterIssues = {
    source: 'human-gate' as const,
    verdict: 'issues' as const,
    unresolvedCount: 2,
    retryCount: 1,
    maxRetries: 3,
    reviewedHeadSha: 'new',
  };
  assert.equal(latestExhaustedReview([oldCap, laterIssues]), undefined);
  assert.equal(
    latestExhaustedReview([
      oldCap,
      {
        source: 'human-gate',
        verdict: 'issues',
        unresolvedCount: 2,
        retryCount: 3,
        maxRetries: 3,
        reviewedHeadSha: 'new',
      },
    ])?.unresolvedCount,
    2,
  );
});

test('exhaustion does not depend on the prepared package HEAD', () => {
  const exhausted = {
    source: 'human-gate' as const,
    verdict: 'issues' as const,
    unresolvedCount: 2,
    retryCount: 3,
    maxRetries: 3,
    reviewedHeadSha: 'abc',
    reviewedReviewSubjectHash: 'old-subject',
  };
  assert.equal(
    latestExhaustedReview([exhausted])?.unresolvedCount,
    2,
    'HEAD drift must not hide the exhausted extra-review bypass',
  );
});

test('cap copy names the remaining findings and the two unblock paths', () => {
  assert.match(
    reviewRetryCapReason({
      verdict: 'issues',
      unresolvedCount: 6,
      retryCount: 3,
      maxRetries: 3,
    }),
    /3\/3 fix attempts.*6 findings remain.*Request another review.*bypass publish/,
  );
  assert.equal(
    latestExhaustedReview([
      { source: 'pipeline', verdict: 'pass', unresolvedCount: 0 },
      {
        source: 'human-gate',
        verdict: 'issues',
        unresolvedCount: 1,
        maxRetriesExhausted: true,
      },
    ])?.unresolvedCount,
    1,
  );
});

test('round budget shows spent rounds independently of passing-review counts', () => {
  assert.equal(reviewRoundBudget(4).label, 'Review rounds 4/5');
  assert.equal(reviewRoundBudget(4).remaining, 1);
  assert.equal(reviewRoundBudget(5).remaining, 0);
  assert.match(reviewRoundBudget(5).diagnosis!, /design problem or scope creep/);
  assert.equal(reviewRoundBudget(8).label, 'Review rounds 8/5');
});

test('bounded update-branch budget reports two rounds with the existing no-verdict labels', () => {
  const budget = reviewRoundBudget(1, [], 1, MAX_UPDATE_BRANCH_REVIEW_ROUNDS);
  assert.equal(budget.limit, 2);
  assert.equal(budget.remaining, 1);
  assert.equal(reviewRoundBudgetLabel(budget), 'Review rounds 1/2 · 1/3 no-verdict');
  assert.equal(reviewRoundBudget(2, [], 0, MAX_UPDATE_BRANCH_REVIEW_ROUNDS).remaining, 0);
  assert.equal(reviewRoundBudget(2).remaining, 3);
});

test('round budget reports no-verdict attempts against their cap without changing the rounds', () => {
  const plain = reviewRoundBudget(5);
  assert.equal(plain.noVerdict, 0);
  assert.equal(plain.noVerdictLimit, REVIEW_NO_VERDICT_LIMIT);
  assert.equal(reviewRoundBudgetLabel(plain), 'Review rounds 5/5');

  const settled = reviewRoundBudget(4, [], 1);
  assert.equal(settled.remaining, 1);
  assert.equal(settled.diagnosis, undefined);
  assert.equal(settled.label, 'Review rounds 4/5');
  assert.equal(reviewRoundBudgetLabel(settled), 'Review rounds 4/5 · 1/3 no-verdict');
  assert.equal(reviewRoundBudget(5, [], 2).diagnosis, plain.diagnosis);
});
