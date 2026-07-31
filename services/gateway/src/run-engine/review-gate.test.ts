import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldIncludeReviewEvidence } from './review-gate.js';

test('review evidence is included unless the operator explicitly excludes it', () => {
  assert.equal(shouldIncludeReviewEvidence(), true);
  assert.equal(shouldIncludeReviewEvidence({}), true);
  assert.equal(shouldIncludeReviewEvidence({ includeEvidence: true }), true);
  assert.equal(shouldIncludeReviewEvidence({ includeEvidence: false }), false);
});
