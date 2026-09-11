import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRReviewObservation } from '../contracts/pr-rules.js';

import { prReviewBlockedReason } from './pr-review-requirements.js';

const observation: PRReviewObservation = {
  observedAt: '2026-09-10T12:00:00.000Z',
  headSha: 'current',
  state: 'open',
  draft: false,
  decision: 'REVIEW_REQUIRED',
  reviewer: 'reader',
  requested: false,
  review: null,
};
test('satisfied requirements and reviews already submitted on this head block duplicate work', () => {
  assert(prReviewBlockedReason({ ...observation, decision: 'APPROVED' }));
  for (const state of ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED']) {
    assert(
      prReviewBlockedReason({
        ...observation,
        review: { state, commit: 'current', submittedAt: null },
      }),
    );
  }
  assert(prReviewBlockedReason({ ...observation, state: 'merged' }));
  assert(prReviewBlockedReason({ ...observation, state: 'closed' }));
  assert(prReviewBlockedReason({ ...observation, draft: true }));
});
test('new commits or an explicit re-request allow review eligibility without granting authority', () => {
  const approved = {
    ...observation,
    review: { state: 'APPROVED', commit: 'current', submittedAt: null },
  };
  assert.equal(prReviewBlockedReason({ ...approved, headSha: 'new' }), undefined);
  assert.equal(
    prReviewBlockedReason({ ...approved, decision: 'APPROVED', requested: true }),
    undefined,
  );
  for (const state of ['PENDING', 'DISMISSED'])
    assert.equal(
      prReviewBlockedReason({ ...approved, review: { ...approved.review, state } }),
      undefined,
    );
  assert.equal(prReviewBlockedReason(undefined), undefined);
});
