import assert from 'node:assert/strict';
import test from 'node:test';

import type { IndependentReviewAttempt } from '../../src/contracts/runs.js';
import {
  independentReviewFixRetriesExhausted,
  independentReviewRetryCapReason,
  independentReviewRetryCount,
  latestExhaustedIndependentReview,
  stampIndependentReviewRetryCap,
} from '../../src/runs/review-retries.js';

const attempt = (extras: Partial<IndependentReviewAttempt> = {}): IndependentReviewAttempt => ({
  loopNumber: 1,
  verdict: 'issues',
  unresolvedCount: 1,
  ...extras,
});

test('retry count prefers the persisted field then falls back to attempts', () => {
  assert.equal(
    independentReviewRetryCount({
      retryCount: 3,
      attempts: [attempt(), attempt(), attempt(), attempt()],
    }),
    3,
  );
  assert.equal(
    independentReviewRetryCount({ attempts: [attempt(), attempt(), attempt(), attempt()] }),
    3,
  );
  assert.equal(independentReviewRetryCount({}), 0);
  assert.equal(
    independentReviewRetryCount({
      retryCount: 0,
      attempts: [attempt(), attempt(), attempt(), attempt()],
    }),
    3,
    'a wiped retryCount: 0 must not hide spent attempts',
  );
});

test('stamp repairs a wiped cap so a spent extra-review is exhausted', () => {
  const stamped = stampIndependentReviewRetryCap(
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
    independentReviewFixRetriesExhausted({
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
  assert.equal(independentReviewFixRetriesExhausted(base), true);
  assert.equal(independentReviewFixRetriesExhausted({ ...base, retryCount: 2 }), false);
  assert.equal(
    independentReviewFixRetriesExhausted({
      ...base,
      retryCount: 2,
      maxRetriesExhausted: true,
    }),
    true,
  );
});

test('max_retries 0 is not a cap-hit; missing maxRetries is not inferred', () => {
  assert.equal(
    independentReviewFixRetriesExhausted({
      source: 'human-gate',
      verdict: 'issues',
      unresolvedCount: 6,
      retryCount: 0,
      maxRetries: 0,
    }),
    false,
  );
  assert.equal(
    independentReviewFixRetriesExhausted({
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
  assert.equal(latestExhaustedIndependentReview([oldCap, laterIssues]), undefined);
  assert.equal(
    latestExhaustedIndependentReview([
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
    latestExhaustedIndependentReview([exhausted])?.unresolvedCount,
    2,
    'HEAD drift must not hide the exhausted extra-review bypass',
  );
});

test('cap copy names the remaining findings and the two unblock paths', () => {
  assert.match(
    independentReviewRetryCapReason({
      verdict: 'issues',
      unresolvedCount: 6,
      retryCount: 3,
      maxRetries: 3,
    }),
    /3\/3 fix attempts.*6 findings remain.*Request another review.*bypass publish/,
  );
  assert.equal(
    latestExhaustedIndependentReview([
      { source: 'self-review', verdict: 'pass', unresolvedCount: 0 },
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
