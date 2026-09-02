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
    ...(existing?.countingVersion === 2 ? { countingVersion: 2 as const } : {}),
    requestedBy: existing?.requestedBy ?? 'dispatch',
  };
}

export function effectiveRequiredReviewCount(policy: ReviewDepthPolicy): number {
  const base = minimumIndependentReviewCount(policy);
  return base + Math.max(0, policy.extraLoopsRequested);
}

function minimumIndependentReviewCount(policy: ReviewDepthPolicy): number {
  return Math.max(policy.requireCrossRunner ? 1 : 0, Math.max(0, policy.minimumIndependentReviews));
}

export function isQualifyingIndependentReview(review: IndependentReviewStatus): boolean {
  return review.source !== 'self-review' && !review.id.startsWith('self-review-');
}

export function independentReviewPolicySatisfied(
  policy: ReviewDepthPolicy,
  reviews: IndependentReviewStatus[],
): boolean {
  const required = effectiveRequiredReviewCount(policy);
  if (required === 0) return true;
  const passing = reviews.filter(
    (review) =>
      isQualifyingIndependentReview(review) &&
      review.verdict === 'pass' &&
      review.unresolvedCount === 0,
  );
  if (passing.length < required) return false;
  if (policy.requireCrossRunner && !passing.some((review) => review.crossRunner)) return false;
  return true;
}

/**
 * Repairs the v1 dispatch encoding that counted every configured
 * review both as the publication minimum and as an extra loop. The exact
 * fingerprint is a drained dispatch plan with N materialized dispatch reviews and
 * `extraLoopsRequested=N`; current dispatches encode N reviews as minimum 1
 * plus N-1 extras and do not match it.
 */
export function repairLegacyDispatchReviewDepth(
  policy: ReviewDepthPolicy,
  reviews: IndependentReviewStatus[],
  pendingReviewCount: number,
): ReviewDepthPolicy {
  if (
    policy.countingVersion === 2 ||
    policy.requestedBy !== 'dispatch' ||
    policy.extraLoopsRequested < 1 ||
    pendingReviewCount > 0
  ) {
    return policy;
  }
  const dispatchReviews = reviews.filter(
    (review) => isQualifyingIndependentReview(review) && review.source === 'dispatch',
  ).length;
  if (dispatchReviews !== policy.extraLoopsRequested) return policy;
  const minimum = minimumIndependentReviewCount(policy);
  return {
    ...policy,
    extraLoopsRequested: Math.max(0, dispatchReviews - minimum),
    countingVersion: 2,
  };
}

/** Normalize persisted v1 dispatch plans before they become new Runs. */
export function normalizeReviewDepthForRunCreate(
  policy: ReviewDepthPolicy | undefined,
  pendingPlanLength: number,
): ReviewDepthPolicy | undefined {
  if (
    !policy ||
    policy.countingVersion === 2 ||
    policy.requestedBy !== 'dispatch' ||
    pendingPlanLength < 1 ||
    policy.extraLoopsRequested !== pendingPlanLength
  ) {
    return policy;
  }
  const minimum = minimumIndependentReviewCount(policy);
  return {
    ...policy,
    extraLoopsRequested: Math.max(0, pendingPlanLength - minimum),
    countingVersion: 2,
  };
}
