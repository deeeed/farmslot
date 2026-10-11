import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inferReviewSourceKind,
  PIPELINE_REVIEW_SOURCE,
  REQUESTED_REVIEW_SOURCE,
  reviewLoopNumberFromId,
} from './review-sources.js';

test('pipeline and requested review artifacts have distinct neutral namespaces', () => {
  const pipeline = PIPELINE_REVIEW_SOURCE.artifactRefs(1);
  const requested = REQUESTED_REVIEW_SOURCE.artifactRefs(1);
  assert.equal(pipeline.id, 'pipeline-review-1');
  assert.equal(requested.id, 'review-1');
  assert.notEqual(pipeline.jsonRel, requested.jsonRel);
  assert.equal(inferReviewSourceKind(pipeline), 'pipeline');
  assert.equal(inferReviewSourceKind(requested), 'requested');
});

test('review source parser rejects foreign and invalid ids', () => {
  assert.equal(reviewLoopNumberFromId(REQUESTED_REVIEW_SOURCE, 'review-7'), 7);
  assert.equal(reviewLoopNumberFromId(REQUESTED_REVIEW_SOURCE, 'pipeline-review-7'), null);
  assert.equal(reviewLoopNumberFromId(REQUESTED_REVIEW_SOURCE, 'review-0'), null);
  assert.throws(() => inferReviewSourceKind({ id: 'unknown-1' }));
});
