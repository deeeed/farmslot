import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewStatus } from '@farmslot/protocol';

import {
  assertPublicationReviewPolicySatisfied,
  countStalePublicationReviews,
  publicationReviewMatchesPreparedPackage,
  reviewFinalSnapshotMatchesPreparedPackage,
} from './gate-policy.js';
import { makeReadyGatePackage, makeRun } from './test-fixtures.js';

function deltaFallback(base = 'head') {
  const prepared = makeReadyGatePackage({
    headSha: 'head',
    reviewSubjectHash: 'current-subject',
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
    reviewSnapshot: {
      source: 'local-git',
      baseRef: 'origin/main',
      baseSha: 'pr-base',
      headSha: 'head',
      diffHash: 'whole-contribution',
      capturedAt: '2026-10-21T03:51:00Z',
    },
  });
  const review: ReviewStatus = {
    id: 'pipeline-review',
    source: 'pipeline',
    mode: 'cold',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    issues: [],
    reviewerSessionId: 'fallback-session',
    reviewedHeadSha: 'head',
    reviewedPackageInputHash: prepared.packageInputHash,
    reviewedReviewSubjectHash: prepared.reviewSubjectHash,
    session: {
      mode: 'cold',
      continuity: 'fresh',
      reviewId: 'pipeline-review',
      sessionId: 'fallback-session',
      lastReviewedHeadSha: 'head',
      fallback: {
        reason: 'missing-session',
        detail: 'The retained session was unavailable.',
        comparedRanges: [`${base}..head`],
      },
    },
    reviewSnapshot: {
      source: 'local-git',
      baseRef: base,
      baseSha: base,
      headSha: 'head',
      diffHash: base === 'head' ? 'empty-delta' : 'delta',
      capturedAt: '2026-10-21T03:27:00Z',
    },
  };
  return { prepared, review };
}

for (const base of ['head', 'previous'])
  test(`a retained COLD delta fallback pass at ${base}..head satisfies the publication gate`, () => {
    const { prepared, review } = deltaFallback(base);
    const before = structuredClone(review);
    assert.equal(reviewFinalSnapshotMatchesPreparedPackage(review, prepared), true);
    assert.equal(publicationReviewMatchesPreparedPackage(review, prepared), true);
    assert.equal(countStalePublicationReviews([review], prepared), 0);
    assert.doesNotThrow(() =>
      assertPublicationReviewPolicySatisfied(
        makeRun({ engineState: { publishGate: { reviews: [review] } } }),
        prepared,
      ),
    );
    assert.deepEqual(review, before, 'admission preserves the retained verdict and session');
  });

test('a rebased delta fallback binds its captured current range', () => {
  const { prepared, review } = deltaFallback('rebased-base');
  assert.ok(review.session?.fallback);
  review.session.fallback.comparedRanges = ['old-base..previous', 'rebased-base..head'];
  assert.equal(publicationReviewMatchesPreparedPackage(review, prepared), true);
});

test('plain COLD still requires the full contribution; fallback identity and range remain bound', () => {
  const { prepared, review } = deltaFallback();
  assert.ok(review.session?.fallback);
  const session = review.session;
  const fallback = session.fallback;
  assert.ok(fallback);
  const invalid: ReviewStatus[] = [
    { ...review, session: { ...session, fallback: undefined } },
    { ...review, session: { ...session, continuity: 'refused' } },
    { ...review, session: { ...session, reviewId: 'other-lineage' } },
    { ...review, session: { ...session, sessionId: 'other-session' } },
    { ...review, session: { ...session, lastReviewedHeadSha: 'old-head' } },
    { ...review, session: { ...session, fallback: { ...fallback, comparedRanges: [] } } },
    {
      ...review,
      session: { ...session, fallback: { ...fallback, comparedRanges: ['other..head'] } },
    },
  ];
  for (const candidate of invalid)
    assert.equal(reviewFinalSnapshotMatchesPreparedPackage(candidate, prepared), false);
  assert.equal(
    reviewFinalSnapshotMatchesPreparedPackage(
      {
        ...review,
        session: { ...session, fallback: undefined },
        reviewSnapshot: prepared.reviewSnapshot,
      },
      prepared,
    ),
    true,
    'full-scope COLD behavior is unchanged',
  );
});

test('delta fallback never certifies a changed package head or reviewed subject', () => {
  const { prepared, review } = deltaFallback();
  for (const changed of [
    { ...prepared, headSha: 'new-head' },
    { ...prepared, reviewSubjectHash: 'changed-evidence' },
  ]) {
    assert.equal(publicationReviewMatchesPreparedPackage(review, changed), false);
    assert.equal(countStalePublicationReviews([review], changed), 1);
  }
});
