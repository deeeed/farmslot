import type { IndependentReviewStatus } from '../contracts/runs.js';

export const APPROVE_PUBLISH_UNRESOLVED_ACTION = 'approve-publish-unresolved';

type ReviewRetryFields = Partial<
  Pick<
    IndependentReviewStatus,
    | 'source'
    | 'verdict'
    | 'unresolvedCount'
    | 'issues'
    | 'feedbackSent'
    | 'recoveryContinuationPending'
    | 'retryCount'
    | 'maxRetries'
    | 'maxRetriesExhausted'
    | 'attempts'
    | 'reviewedHeadSha'
    | 'reviewedReviewSubjectHash'
    | 'reviewSnapshot'
  >
>;

export function independentReviewRetryCount(review: ReviewRetryFields): number {
  if (typeof review.retryCount === 'number' && Number.isFinite(review.retryCount)) {
    return Math.max(0, Math.round(review.retryCount));
  }
  return Math.max(0, (review.attempts?.length ?? 1) - 1);
}

/**
 * True when an extra/independent review consumed its auto-fix budget with
 * findings still open. `max_retries: 0` is not a cap-hit: the operator still
 * uses Continue Fixing to authorize the first worker pass.
 *
 * Records without `maxRetries` are exhausted only when `maxRetriesExhausted`
 * was persisted. Missing cap fields are not inferred.
 */
export function independentReviewFixRetriesExhausted(review: ReviewRetryFields): boolean {
  if (review.source === 'self-review') return false;
  if (review.verdict !== 'issues') return false;
  const findings = Math.max(review.unresolvedCount ?? 0, review.issues?.length ?? 0);
  if (findings <= 0) return false;
  const retryCount = independentReviewRetryCount(review);
  if (typeof review.maxRetries === 'number' && Number.isFinite(review.maxRetries)) {
    if (review.maxRetries <= 0) return false;
    return retryCount >= review.maxRetries;
  }
  return review.maxRetriesExhausted === true;
}

export function independentReviewRetryCapReason(review: ReviewRetryFields): string {
  const retryCount = independentReviewRetryCount(review);
  const findings = Math.max(review.unresolvedCount ?? 0, review.issues?.length ?? 0);
  const findingLabel = `${findings} finding${findings === 1 ? '' : 's'}`;
  if (typeof review.maxRetries === 'number' && Number.isFinite(review.maxRetries)) {
    return `Independent review stopped after ${retryCount}/${review.maxRetries} fix attempts; ${findingLabel} remain. Request another review, or bypass publish (dangerous).`;
  }
  return `Independent review stopped after ${retryCount} fix attempt${retryCount === 1 ? '' : 's'}; ${findingLabel} remain. Request another review, or bypass publish (dangerous).`;
}

export function latestIndependentReview(
  reviews: readonly ReviewRetryFields[] | undefined,
): ReviewRetryFields | undefined {
  return [...(reviews ?? [])]
    .reverse()
    .find(
      (review) =>
        review.source !== 'self-review' &&
        (review.verdict === 'pass' || review.verdict === 'issues'),
    );
}

export function independentReviewMatchesPreparedPackage(
  review: ReviewRetryFields,
  preparedPackage?: { headSha?: string | null; reviewSubjectHash?: string | null } | null,
): boolean {
  if (!preparedPackage) return true;
  const head = preparedPackage.headSha?.trim();
  const reviewedHead = (review.reviewedHeadSha ?? review.reviewSnapshot?.headSha)?.trim();
  if (!head || !reviewedHead || reviewedHead !== head) return false;
  // HEAD only. Subject-hash drift must not hide bypass.
  return true;
}

/** Latest terminal extra-review that hit its auto-fix cap on this package. */
export function latestExhaustedIndependentReview(
  reviews: readonly ReviewRetryFields[] | undefined,
  preparedPackage?: { headSha?: string | null; reviewSubjectHash?: string | null } | null,
): ReviewRetryFields | undefined {
  const latest = latestIndependentReview(reviews);
  if (!latest || !independentReviewFixRetriesExhausted(latest)) return undefined;
  if (!independentReviewMatchesPreparedPackage(latest, preparedPackage)) return undefined;
  return latest;
}
