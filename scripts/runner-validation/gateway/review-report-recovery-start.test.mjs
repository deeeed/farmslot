import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceptedReviewStartAt } from './review-report-recovery-start.mjs';

test('review recovery uses transport-specific accepted worker evidence', () => {
  const context = {
    id: 'review',
    promptDeliveryStartedAt: '2026-09-23T08:00:00.000Z',
    nativeSession: { acceptedAt: '2026-09-23T08:01:00.000Z' },
  };
  assert.equal(
    acceptedReviewStartAt({ transport: 'tmux', agentContexts: [context] }),
    context.promptDeliveryStartedAt,
  );
  assert.equal(
    acceptedReviewStartAt({ transport: 'native', agentContexts: [context] }),
    context.nativeSession.acceptedAt,
  );
  assert.equal(
    acceptedReviewStartAt({ transport: 'native', agentContexts: [{ id: 'review' }] }),
    undefined,
  );
});
