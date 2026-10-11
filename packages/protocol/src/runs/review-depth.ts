import type { IndependentReviewStatus, ReviewDepthPolicy } from '../contracts/runs.js';

/**
 * Normalizes an already-computed publication review snapshot. The gateway's
 * `publicationReviewPolicyForRun()` derives flow defaults; this helper preserves
 * legacy review-gate behavior only for already-materialized snapshots.
 */
export function defaultReviewDepthPolicy(existing?: ReviewDepthPolicy | null): ReviewDepthPolicy {
  const requireCrossRunner = existing?.requireCrossRunner === true;
  const minimumIndependentReviews = Math.max(
    requireCrossRunner ? 1 : 0,
    existing?.minimumIndependentReviews ?? 1,
  );
  return {
    minimumIndependentReviews,
    requireCrossRunner,
    extraLoopsRequested: Math.max(0, existing?.extraLoopsRequested ?? 0),
    ...(existing?.countingVersion === 2 ? { countingVersion: 2 as const } : {}),
    requestedBy: existing?.requestedBy ?? 'dispatch',
  };
}

export function effectiveRequiredReviewCount(policy: ReviewDepthPolicy): number {
  const base = minimumIndependentReviewCount(policy);
  return base + Math.max(0, policy.extraLoopsRequested);
}

export function minimumIndependentReviewCount(policy: ReviewDepthPolicy): number {
  return Math.max(policy.requireCrossRunner ? 1 : 0, Math.max(0, policy.minimumIndependentReviews));
}

/** A reviewer's verdict, as opposed to the worker's own self-review pass. */
export function isQualifyingIndependentReview(
  review: Pick<IndependentReviewStatus, 'id' | 'source'>,
): boolean {
  return review.source !== 'self-review' && !review.id.startsWith('self-review-');
}
