import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadyGatePayload, ReviewStatus } from '../src/contracts/runs.js';
import { reviewFindingId } from '../src/runs/review-findings.js';
import { reviewPolicySatisfied, reviewRequirementDisplay } from '../src/runs/review-policy.js';

const payload = (): ReadyGatePayload => ({
  kind: 'ready',
  prNumber: null,
  repo: null,
  branch: 'feature',
  workerReport: 'Retained work.',
  diffStat: { files: 1, additions: 1, deletions: 0 },
  headSha: 'a'.repeat(40),
  reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  reviews: [
    {
      id: 'old',
      mode: 'cold',
      loopNumber: 1,
      verdict: 'failed',
      unresolvedCount: 1,
      reviewedHeadSha: 'b'.repeat(40),
    },
  ],
});

test('person-settled evidence findings satisfy review policy without changing the recorded verdict', () => {
  const issue = {
    file: 'artifacts/evidence-manifest.json',
    description: 'AC-1 needs a visual decision.',
  };
  const review: ReviewStatus = {
    id: 'review',
    source: 'pipeline',
    mode: 'warm',
    loopNumber: 1,
    reviewerSessionId: 'session',
    reviewedHeadSha: 'head',
    verdict: 'issues',
    unresolvedCount: 1,
    issues: [issue],
    settledFindings: [
      {
        reviewId: 'review',
        headSha: 'head',
        claimId: 'AC-1',
        findingId: reviewFindingId('review', 'head', issue),
        receiptId: 'person-receipt',
      },
    ],
  };
  const policy = { minimumReviews: 1, requestedBy: 'dispatch' as const };
  assert.equal(reviewPolicySatisfied(policy, [review]), true);
  assert.equal(review.verdict, 'issues');
  assert.deepEqual(review.issues, [issue]);
  assert.equal(
    reviewPolicySatisfied(policy, [{ ...review, reviewedHeadSha: 'other-head' }]),
    false,
  );
  assert.equal(
    reviewPolicySatisfied(policy, [
      {
        ...review,
        unresolvedCount: 2,
        issues: [issue, { file: 'src/orders.ts', description: 'AC-1 submits the wrong quantity.' }],
      },
    ]),
    false,
  );
});

test('zero required reviews remain satisfied with failed historical attempts', () => {
  const gate = payload();
  const view = reviewRequirementDisplay(gate);
  assert.equal(view.label, 'No independent review required');
  assert.equal(view.satisfied, true);
  assert.equal(view.counts.totalAttempts, 1);
  assert.equal(view.counts.trustedPassingReviews, 0);
  assert.equal(gate.reviews?.[0].verdict, 'failed');
});

test('a required review qualifies only the frozen head, subject and separate session', () => {
  const gate = payload();
  gate.reviewPolicy = { minimumReviews: 1, requestedBy: 'dispatch' };
  gate.prPackage = {
    id: 'package',
    gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'Operator review' },
    publicationTarget: 'draft',
    publicationStatus: 'not_published',
    packageHash: 'hash',
    artifactPath: 'artifacts/pr-package.json',
    branch: gate.branch,
    headSha: gate.headSha!,
    reviewSubjectHash: 'subject',
    diffStat: gate.diffStat,
    draftTitle: 'Title',
    draftBody: 'Body',
    reviewArtifactIds: [],
    createdAt: '2026-10-14T00:00:00Z',
  };
  const review: ReviewStatus = {
    id: 'current',
    mode: 'cold',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    reviewerSessionId: 'separate',
    reviewedHeadSha: 'b'.repeat(40),
    reviewedReviewSubjectHash: 'subject',
  };
  gate.reviews = [review];
  assert.equal(reviewRequirementDisplay(gate).satisfied, false);
  review.reviewedHeadSha = gate.headSha;
  assert.equal(reviewRequirementDisplay(gate).satisfied, true);
  review.reviewedReviewSubjectHash = 'old-subject';
  assert.equal(reviewRequirementDisplay(gate).satisfied, false);
});
