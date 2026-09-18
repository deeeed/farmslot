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
  >
>;

export function independentReviewRetryCount(review: ReviewRetryFields): number {
  if (typeof review.retryCount === 'number' && Number.isFinite(review.retryCount)) {
    return Math.max(0, Math.round(review.retryCount));
  }
  return Math.max(0, (review.attempts?.length ?? 1) - 1);
}

/** True when an extra/independent review stopped auto-fixing with findings still open. */
export function independentReviewFixRetriesExhausted(review: ReviewRetryFields): boolean {
  if (review.source === 'self-review') return false;
  if (review.verdict !== 'issues') return false;
  const findings = Math.max(review.unresolvedCount ?? 0, review.issues?.length ?? 0);
  if (findings <= 0) return false;
  if (review.maxRetriesExhausted === true) return true;
  const retryCount = independentReviewRetryCount(review);
  if (typeof review.maxRetries === 'number' && Number.isFinite(review.maxRetries)) {
    return retryCount >= review.maxRetries;
  }
  return (
    review.feedbackSent !== true && review.recoveryContinuationPending === true && retryCount >= 1
  );
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

export function firstExhaustedIndependentReview(
  reviews: readonly ReviewRetryFields[] | undefined,
): ReviewRetryFields | undefined {
  return reviews?.find((review) => independentReviewFixRetriesExhausted(review));
}
