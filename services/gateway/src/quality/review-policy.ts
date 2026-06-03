import type { IndependentReviewStatus, ReviewDepthPolicy } from '@farmslot/protocol';

/**
 * Normalizes an already-computed publication review snapshot. Use
 * publicationReviewPolicyForRun() when deriving flow defaults; this helper preserves
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
    requestedBy: existing?.requestedBy ?? 'dispatch',
  };
}

export function effectiveRequiredReviewCount(policy: ReviewDepthPolicy): number {
  const base = Math.max(
    policy.requireCrossRunner ? 1 : 0,
    Math.max(0, policy.minimumIndependentReviews),
  );
  return base + Math.max(0, policy.extraLoopsRequested);
}

export function independentReviewPolicySatisfied(
  policy: ReviewDepthPolicy,
  reviews: IndependentReviewStatus[],
): boolean {
  const required = effectiveRequiredReviewCount(policy);
  if (required === 0) return true;
  const passing = reviews.filter(
    (review) => review.verdict === 'pass' && review.unresolvedCount === 0,
  );
  if (passing.length < required) return false;
  if (policy.requireCrossRunner && !passing.some((review) => review.crossRunner)) return false;
  if (!passing.some((review) => (review.validationDepth ?? 'full-live') === 'full-live'))
    return false;
  return true;
}
