import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewEvidencePostArgs, shouldIncludeReviewEvidence } from './review-gate.js';

test('review evidence is included unless the operator explicitly excludes it', () => {
  assert.equal(shouldIncludeReviewEvidence(), true);
  assert.equal(shouldIncludeReviewEvidence({}), true);
  assert.equal(shouldIncludeReviewEvidence({ includeEvidence: true }), true);
  assert.equal(shouldIncludeReviewEvidence({ includeEvidence: false }), false);
});

test('review posting omits the evidence file argument when the operator excludes evidence', () => {
  assert.deepEqual(
    reviewEvidencePostArgs({ includeEvidence: false }, '/tmp/review-evidence.md'),
    [],
  );
  assert.deepEqual(reviewEvidencePostArgs({}, '/tmp/review-evidence.md'), [
    '--evidence-md-file',
    '/tmp/review-evidence.md',
  ]);
});
