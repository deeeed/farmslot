import type { ReviewPolicy, ReviewStatus } from '../contracts/runs.js';

export function defaultReviewPolicy(existing?: ReviewPolicy | null): ReviewPolicy {
  return {
    minimumReviews: Math.max(0, existing?.minimumReviews ?? 1),
    requestedBy: existing?.requestedBy ?? 'dispatch',
  };
}

export function effectiveRequiredReviewCount(policy: ReviewPolicy): number {
  return Math.max(0, policy.minimumReviews);
}

/** A separate reviewer session and a captured reviewed head are required evidence. */
export function isQualifyingReview(review: ReviewStatus): boolean {
  return (
    !!review.reviewerSessionId?.trim() &&
    !!(review.reviewedHeadSha ?? review.reviewSnapshot?.headSha)?.trim()
  );
}

/** Retrying a session replaces its verdict, including a later failure on the same head. */
export function qualifyingPassingReviews(reviews: ReviewStatus[]): ReviewStatus[] {
  const latest = new Map<string, ReviewStatus>();
  for (const review of reviews) latest.set(review.id, review);
  const sessions = new Set<string>();
  return [...latest.values()].filter((review) => {
    if (
      !isQualifyingReview(review) ||
      review.verdict !== 'pass' ||
      review.unresolvedCount !== 0 ||
      sessions.has(review.reviewerSessionId!)
    )
      return false;
    sessions.add(review.reviewerSessionId!);
    return true;
  });
}

export function reviewPolicySatisfied(policy: ReviewPolicy, reviews: ReviewStatus[]): boolean {
  return qualifyingPassingReviews(reviews).length >= effectiveRequiredReviewCount(policy);
}
