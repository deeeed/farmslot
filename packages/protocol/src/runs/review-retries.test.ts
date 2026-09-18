import assert from 'node:assert/strict';
import test from 'node:test';

import type { IndependentReviewAttempt } from '../contracts/runs.js';

import {
  firstExhaustedIndependentReview,
  independentReviewFixRetriesExhausted,
  independentReviewRetryCapReason,
  independentReviewRetryCount,
} from './review-retries.js';

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
});

test('infers exhaustion from pending undelivered findings after at least one fix', () => {
  assert.equal(
    independentReviewFixRetriesExhausted({
      source: 'human-gate',
      verdict: 'issues',
      unresolvedCount: 6,
      feedbackSent: false,
      recoveryContinuationPending: true,
      attempts: [attempt(), attempt(), attempt(), attempt()],
    }),
    true,
  );
  assert.equal(
    independentReviewFixRetriesExhausted({
      source: 'self-review',
      verdict: 'issues',
      unresolvedCount: 6,
      feedbackSent: false,
      recoveryContinuationPending: true,
      attempts: [attempt(), attempt()],
    }),
    false,
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
    firstExhaustedIndependentReview([
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
