import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewStatus, Run } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';

import {
  codeReviewCertifiesPRCompletion,
  reviewAcceptanceCriteria,
} from './acceptance-coverage.js';

const head = 'a'.repeat(40);
function fixture(): Run {
  return {
    ...makeRun({ flowType: 'pr-complete' }),
    acceptanceContractVersion: 1,
    acceptanceExecutionContract: {
      schemaVersion: 1,
      runId: 'run-1',
      revision: 1,
      registrationRevision: 1,
      baseContractHash: 'b'.repeat(64),
      inheritedCriterionIds: [],
      proofModes: [{ id: 'AC-1', text: 'Preserve balance semantics', proofMode: 'review' }],
      claimReviewGate: false,
      publicationReview: true,
    },
  };
}
function pass(run: Run, session = 'independent-session'): ReviewStatus {
  return {
    id: session,
    source: 'pipeline',
    mode: 'cold',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    reviewerSessionId: session,
    reviewedHeadSha: head,
    acceptanceReviewCoverage: reviewAcceptanceCriteria(run),
  };
}
function reviews(run: Run, rows: ReviewStatus[]): void {
  run.engineState = { publishGate: { reviews: rows } };
}

test('a qualifying current-head review certifies only criteria included in its request', () => {
  const run = fixture();
  reviews(run, [pass(run)]);
  assert.equal(codeReviewCertifiesPRCompletion(run, head), true);
  assert.equal(codeReviewCertifiesPRCompletion(run, 'c'.repeat(40)), false);
  reviews(run, [{ ...pass(run), acceptanceReviewCoverage: undefined }]);
  assert.equal(codeReviewCertifiesPRCompletion(run, head), false);
  reviews(run, [{ ...pass(run), reviewerSessionId: null }]);
  assert.equal(codeReviewCertifiesPRCompletion(run, head), false);
});

test('new review obligations invalidate an unchanged-head pass; state-only appends do not', () => {
  const run = fixture();
  const old = pass(run);
  reviews(run, [old]);
  run.acceptanceExecutionContract!.proofModes.push({
    id: 'AC-2',
    text: 'Additional state proof',
    proofMode: 'state',
  });
  assert.equal(codeReviewCertifiesPRCompletion(run, head), true);
  run.acceptanceExecutionContract!.proofModes.push({
    id: 'AC-3',
    text: 'Check another invariant',
    proofMode: 'review',
  });
  assert.equal(codeReviewCertifiesPRCompletion(run, head), false);
  reviews(run, [pass(run)]);
  assert.equal(codeReviewCertifiesPRCompletion(run, head), true);
});

test('a later failing verdict and the configured independent-review count still apply', () => {
  const run = fixture();
  const first = pass(run);
  reviews(run, [first, { ...first, id: 'later', verdict: 'issues', unresolvedCount: 1 }]);
  assert.equal(codeReviewCertifiesPRCompletion(run, head), false);
  reviews(run, [first]);
  run.engineState!.publishGate!.reviewPolicy = { minimumReviews: 2, requestedBy: 'dispatch' };
  assert.equal(codeReviewCertifiesPRCompletion(run, head), false);
  run.engineState!.publishGate!.reviews!.push(pass(run, 'second-independent-session'));
  assert.equal(codeReviewCertifiesPRCompletion(run, head), true);
});

test('inherited review criteria add no fresh review obligation', () => {
  const run = fixture();
  run.acceptanceExecutionContract!.inheritedCriterionIds = ['AC-1'];
  assert.deepEqual(reviewAcceptanceCriteria(run), []);
});
