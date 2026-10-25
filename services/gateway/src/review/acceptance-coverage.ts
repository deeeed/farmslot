import { createHash } from 'node:crypto';

import {
  type AcceptanceReviewCriterion,
  qualifyingPassingReviews,
  reviewFindingsSatisfied,
  type ReviewStatus,
  type Run,
} from '@farmslot/protocol';

import { ghRequest } from '../integrations/github-client.js';

import { reviewPRIdentity } from './session-mode.js';

export async function readPRCompletionHead(run: Run): Promise<string> {
  const pr = reviewPRIdentity(run, { requirePRContext: true });
  if (!pr) throw new Error('PR completion has no bound pull request');
  const result = await ghRequest(
    [
      'pr',
      'view',
      String(pr.prNumber),
      '--repo',
      pr.repository,
      '--json',
      'headRefOid',
      '--jq',
      '.headRefOid',
    ],
    { force: true },
  );
  const head = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/i.test(head)) throw new Error('PR completion pushed head is unavailable');
  return head;
}

/** State-only appends do not change what a code reviewer must judge. */
export function reviewAcceptanceCriteria(run: Run): AcceptanceReviewCriterion[] {
  if (run.flowType !== 'pr-complete' || run.acceptanceContractVersion !== 1) return [];
  const contract = run.acceptanceExecutionContract;
  return (contract?.proofModes ?? [])
    .filter(
      ({ id, proofMode }) =>
        proofMode === 'review' && !contract?.inheritedCriterionIds.includes(id),
    )
    .map(({ id, text }) => ({
      id,
      text,
      proofMode: 'review',
      definitionHash: createHash('sha256')
        .update(JSON.stringify({ id, text, proofMode: 'review' }))
        .digest('hex'),
    }));
}

/** The existing qualifying-session policy, plus explicit frozen criterion coverage. */
export function codeReviewCertifiesPRCompletion(run: Run, pushedHead: string | undefined): boolean {
  const criteria = reviewAcceptanceCriteria(run);
  if (!pushedHead || !criteria.length) return false;
  const reviews = run.engineState?.publishGate?.reviews ?? [];
  if (
    reviews.some(
      (review) =>
        (review.reviewedHeadSha ?? review.reviewSnapshot?.headSha) === pushedHead &&
        review.verdict === 'issues' &&
        !reviewFindingsSatisfied(review),
    )
  )
    return false;
  const passing = qualifyingPassingReviews(reviews).filter((review) =>
    reviewCoversPRCompletionCriteria(run, review, pushedHead),
  );
  return (
    passing.length >= Math.max(1, run.engineState?.publishGate?.reviewPolicy?.minimumReviews ?? 1)
  );
}

export function reviewCoversPRCompletionCriteria(
  run: Run,
  review: ReviewStatus,
  head: string,
): boolean {
  return (
    qualifyingPassingReviews([review]).length === 1 &&
    review.source === 'pipeline' &&
    !review.stale &&
    (review.reviewedHeadSha ?? review.reviewSnapshot?.headSha) === head &&
    reviewAcceptanceCriteria(run).every((criterion) =>
      review.acceptanceReviewCoverage?.some(
        (covered) =>
          covered.id === criterion.id && covered.definitionHash === criterion.definitionHash,
      ),
    )
  );
}
