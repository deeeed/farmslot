import type { ReviewRoundBudget, ReviewStatus } from '../contracts/runs.js';

export const MAX_REVIEW_ROUNDS = 5;

/** Round budget is separate from the number of qualifying passing reviewers. */
export function reviewRoundBudget(used: number): ReviewRoundBudget {
  const count = Number.isFinite(used) ? Math.max(0, Math.floor(used)) : 0;
  return {
    used: count,
    limit: MAX_REVIEW_ROUNDS,
    remaining: Math.max(0, MAX_REVIEW_ROUNDS - count),
    label: `Review rounds ${count}/${MAX_REVIEW_ROUNDS}`,
    ...(count >= MAX_REVIEW_ROUNDS
      ? {
          diagnosis:
            'The five review rounds are spent. A design problem or scope creep has exhausted the review budget; stop and narrow the change or redesign it.',
        }
      : {}),
  };
}

export const APPROVE_PUBLISH_UNRESOLVED_ACTION = 'approve-publish-unresolved';

type ReviewRetryFields = Partial<
  Pick<
    ReviewStatus,
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

export function reviewRetryCount(review: ReviewRetryFields): number {
  const fromAttempts = Math.max(0, (review.attempts?.length ?? 1) - 1);
  if (typeof review.retryCount === 'number' && Number.isFinite(review.retryCount)) {
    return Math.max(0, Math.round(review.retryCount), fromAttempts);
  }
  return fromAttempts;
}

/**
 * True when an review consumed its auto-fix budget with
 * findings still open. `max_retries: 0` is not a cap-hit: the operator still
 * uses Continue Fixing to authorize the first worker pass.
 *
 * Records without `maxRetries` are exhausted only when `maxRetriesExhausted`
 * was persisted. Missing cap fields are not inferred.
 */
export function reviewFixRetriesExhausted(review: ReviewRetryFields): boolean {
  if (review.verdict !== 'issues') return false;
  const findings = Math.max(review.unresolvedCount ?? 0, review.issues?.length ?? 0);
  if (findings <= 0) return false;
  const retryCount = reviewRetryCount(review);
  if (typeof review.maxRetries === 'number' && Number.isFinite(review.maxRetries)) {
    if (review.maxRetries <= 0) return false;
    if (review.maxRetriesExhausted === true) return true;
    return retryCount >= review.maxRetries;
  }
  return review.maxRetriesExhausted === true;
}

/** Repair wiped `retryCount: 0` and stamp a missing cap from project config. */
export function stampReviewRetryCap<T extends ReviewRetryFields>(
  review: T,
  configuredMaxRetries?: number,
): T {
  const retryCount = reviewRetryCount(review);
  const maxRetries =
    typeof review.maxRetries === 'number' && Number.isFinite(review.maxRetries)
      ? review.maxRetries
      : typeof configuredMaxRetries === 'number' && Number.isFinite(configuredMaxRetries)
        ? configuredMaxRetries
        : undefined;
  const next = {
    ...review,
    retryCount,
    ...(typeof maxRetries === 'number' ? { maxRetries } : {}),
  };
  if (!reviewFixRetriesExhausted(next)) return next;
  return { ...next, maxRetriesExhausted: true, recoveryContinuationPending: false };
}

export function reviewRetryCapReason(review: ReviewRetryFields): string {
  const retryCount = reviewRetryCount(review);
  const findings = Math.max(review.unresolvedCount ?? 0, review.issues?.length ?? 0);
  const findingLabel = `${findings} finding${findings === 1 ? '' : 's'}`;
  if (typeof review.maxRetries === 'number' && Number.isFinite(review.maxRetries)) {
    return `Review stopped after ${retryCount}/${review.maxRetries} fix attempts; ${findingLabel} remain. Request another review, or bypass publish (dangerous).`;
  }
  return `Review stopped after ${retryCount} fix attempt${retryCount === 1 ? '' : 's'}; ${findingLabel} remain. Request another review, or bypass publish (dangerous).`;
}

export function latestReview(
  reviews: readonly ReviewRetryFields[] | undefined,
): ReviewRetryFields | undefined {
  return [...(reviews ?? [])]
    .reverse()
    .find((review) => review.verdict === 'pass' || review.verdict === 'issues');
}

/** Latest terminal review that hit its auto-fix cap. Package HEAD drift does not hide this. */
export function latestExhaustedReview(
  reviews: readonly ReviewRetryFields[] | undefined,
): ReviewRetryFields | undefined {
  const latest = latestReview(reviews);
  if (!latest || !reviewFixRetriesExhausted(latest)) return undefined;
  return latest;
}
