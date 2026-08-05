import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertReviewSnapshotMatchesPullRequest,
  reviewEvidencePostArgs,
  shouldIncludeReviewEvidence,
} from './review-gate.js';

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

test('review posting requires an available snapshot for the current PR head', () => {
  const snapshot = {
    source: 'github-pr' as const,
    capturedAt: '2026-08-05T00:00:00.000Z',
    headSha: 'abcdef1234567890',
  };

  assert.doesNotThrow(() => assertReviewSnapshotMatchesPullRequest(snapshot, snapshot.headSha));
  assert.throws(
    () => assertReviewSnapshotMatchesPullRequest(undefined, snapshot.headSha),
    /snapshot is unavailable/i,
  );
  assert.throws(
    () => assertReviewSnapshotMatchesPullRequest(snapshot, 'fedcba0987654321'),
    /review is stale/i,
  );
  assert.throws(
    () =>
      assertReviewSnapshotMatchesPullRequest(
        {
          source: 'unavailable',
          capturedAt: snapshot.capturedAt,
          missingReason: 'diff-unavailable',
        },
        snapshot.headSha,
      ),
    /snapshot is unavailable/i,
  );
});
