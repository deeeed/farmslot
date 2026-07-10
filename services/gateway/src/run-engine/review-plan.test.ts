import assert from 'node:assert/strict';
import test from 'node:test';

import { humanGateReviewDepth } from './review-plan.js';

test('humanGateReviewDepth makes explicit gate review requests temporary but required', () => {
  const basePolicy = {
    minimumIndependentReviews: 0,
    requireCrossRunner: false,
    extraLoopsRequested: 0,
    requestedBy: 'dispatch' as const,
  };

  assert.deepEqual(
    humanGateReviewDepth(
      basePolicy,
      {},
      { actionId: 'request-extra-review', fallbackLoopCount: 1 },
    ),
    {
      minimumIndependentReviews: 1,
      requireCrossRunner: false,
      extraLoopsRequested: 0,
      requestedBy: 'human-gate',
    },
  );

  assert.deepEqual(
    humanGateReviewDepth(basePolicy, {}, { actionId: 'request-cross-runner-review' }),
    {
      minimumIndependentReviews: 1,
      requireCrossRunner: true,
      extraLoopsRequested: 0,
      requestedBy: 'human-gate',
    },
  );
});
