import type { ReadyGatePayload, ReviewPolicy, ReviewStatus } from '../contracts/runs.js';

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
  return qualifyingReviewSessions(
    reviews,
    (review) => review.verdict === 'pass' && review.unresolvedCount === 0,
  );
}

/** Completed review inputs, including real findings that an operator may explicitly accept. */
export function qualifyingTerminalReviewInputs(reviews: ReviewStatus[]): ReviewStatus[] {
  return qualifyingReviewSessions(
    reviews,
    (review) => review.verdict === 'pass' || review.verdict === 'issues',
  );
}

function qualifyingReviewSessions(
  reviews: ReviewStatus[],
  accepts: (review: ReviewStatus) => boolean,
): ReviewStatus[] {
  const latest = new Map<string, ReviewStatus>();
  for (const review of reviews) latest.set(review.id, review);
  const sessions = new Set<string>();
  return [...latest.values()].filter((review) => {
    if (!isQualifyingReview(review) || !accepts(review) || sessions.has(review.reviewerSessionId!))
      return false;
    sessions.add(review.reviewerSessionId!);
    return true;
  });
}

export function reviewPolicySatisfied(policy: ReviewPolicy, reviews: ReviewStatus[]): boolean {
  return qualifyingPassingReviews(reviews).length >= effectiveRequiredReviewCount(policy);
}

export type ReviewFreshnessReason =
  | 'fresh'
  | 'unresolved-findings'
  | 'review-not-passing'
  | 'review-pending'
  | 'reviewed-head-missing'
  | 'reviewed-old-head'
  | 'package-review-subject-missing'
  | 'review-subject-missing'
  | 'review-subject-changed'
  | 'review-snapshot-unavailable'
  | 'review-session-missing';

export interface ReviewFreshnessDisplay {
  review: ReviewStatus;
  reason: ReviewFreshnessReason;
  label: string;
  detail: string;
  stale: boolean;
  passing: boolean;
}

export interface ReviewGateCountSummary {
  requiredReviews: number;
  minimumReviews: number;
  totalReviews: number;
  totalAttempts: number;
  passingReviews: number;
  freshPassingReviews: number;
  trustedPassingReviews: number;
  staleIgnoredReviews: number;
  unresolvedFindings: number;
  freshness: ReviewFreshnessDisplay[];
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : 'unknown';
}

export function normalizedReviewPolicy(payload: ReadyGatePayload): ReviewPolicy {
  return defaultReviewPolicy(payload.prPackage?.reviewPolicy ?? payload.reviewPolicy);
}

export function reviewSourceLabel(review: Pick<ReviewStatus, 'source'>): string {
  return review.source === 'human-gate' ? 'Review (requested)' : 'Review';
}

function reviewIsPassing(review: ReviewStatus): boolean {
  return review.verdict === 'pass' && review.unresolvedCount === 0;
}

function reviewHead(review: ReviewStatus): string | null | undefined {
  return review.reviewedHeadSha ?? review.reviewSnapshot?.headSha;
}

function reviewCertifiesPreparedPackage(review: ReviewStatus, payload: ReadyGatePayload): boolean {
  if (!reviewIsPassing(review) || !(review.reviewerSessionId || review.session?.sessionId))
    return false;
  const packageHead = payload.prPackage?.headSha ?? payload.headSha;
  const packageSubject = payload.prPackage?.reviewSubjectHash?.trim();
  if (!packageHead || !packageSubject) return false;
  const reviewedHead = reviewHead(review);
  if (!reviewedHead || reviewedHead !== packageHead) return false;
  if (!review.reviewedHeadSha && review.reviewSnapshot?.source === 'unavailable') return false;
  return review.reviewedReviewSubjectHash === packageSubject;
}

export function classifyReviewFreshness(
  review: ReviewStatus,
  payload: ReadyGatePayload,
): ReviewFreshnessDisplay {
  const sourceLabel = reviewSourceLabel(review);
  const passing = reviewIsPassing(review);
  if (review.unresolvedCount > 0) {
    return {
      review,
      reason: 'unresolved-findings',
      label: `${sourceLabel} has unresolved findings`,
      detail: `${review.unresolvedCount} unresolved finding${review.unresolvedCount === 1 ? '' : 's'}`,
      stale: false,
      passing,
    };
  }
  if (review.verdict === 'pending') {
    return {
      review,
      reason: 'review-pending',
      label: `${sourceLabel} still running`,
      detail: 'Review has not produced a passing verdict yet',
      stale: false,
      passing,
    };
  }
  if (!passing) {
    return {
      review,
      reason: 'review-not-passing',
      label: `${sourceLabel} is not passing`,
      detail: `Verdict is ${review.verdict}`,
      stale: false,
      passing,
    };
  }

  if (!(review.reviewerSessionId || review.session?.sessionId)) {
    return {
      review,
      reason: 'review-session-missing',
      label: `${sourceLabel} session unavailable`,
      detail: 'Review has no verified separate session.',
      stale: true,
      passing,
    };
  }
  const packageHead = payload.prPackage?.headSha ?? payload.headSha;
  const packageSubject = payload.prPackage?.reviewSubjectHash?.trim();
  const reviewedHead = reviewHead(review);
  const reviewedSubject = review.reviewedReviewSubjectHash;
  if (!review.reviewedHeadSha && review.reviewSnapshot?.source === 'unavailable') {
    return {
      review,
      reason: 'review-snapshot-unavailable',
      label: `${sourceLabel} snapshot unavailable`,
      detail: review.reviewSnapshot.missingReason
        ? `Review snapshot unavailable (${review.reviewSnapshot.missingReason})`
        : 'Review snapshot unavailable',
      stale: true,
      passing,
    };
  }
  if (packageHead && !reviewedHead) {
    return {
      review,
      reason: 'reviewed-head-missing',
      label: `${sourceLabel} did not record reviewed HEAD`,
      detail: `Package HEAD is ${shortSha(packageHead)} but the review has no reviewed HEAD`,
      stale: true,
      passing,
    };
  }
  if (packageHead && reviewedHead !== packageHead) {
    return {
      review,
      reason: 'reviewed-old-head',
      label: `${sourceLabel} reviewed old HEAD`,
      detail: `Reviewed ${shortSha(reviewedHead)}; package HEAD is ${shortSha(packageHead)}`,
      stale: true,
      passing,
    };
  }
  if (!packageSubject) {
    return {
      review,
      reason: 'package-review-subject-missing',
      label: 'Package review subject unavailable',
      detail:
        'Prepared package does not expose a review-subject hash, so reviews cannot certify it',
      stale: true,
      passing,
    };
  }
  if (!reviewedSubject) {
    return {
      review,
      reason: 'review-subject-missing',
      label: `${sourceLabel} did not record package subject`,
      detail: 'Review did not record the package review-subject hash',
      stale: true,
      passing,
    };
  }
  if (reviewedSubject !== packageSubject) {
    return {
      review,
      reason: 'review-subject-changed',
      label: `${sourceLabel} reviewed old package subject`,
      detail: `Reviewed subject ${shortSha(reviewedSubject)}; package subject is ${shortSha(packageSubject)}`,
      stale: true,
      passing,
    };
  }
  return {
    review,
    reason: 'fresh',
    label: `${sourceLabel} fresh`,
    detail: packageHead
      ? `Reviewed package HEAD ${shortSha(packageHead)}`
      : 'Review matches package facts',
    stale: false,
    passing,
  };
}

export function summarizeReviewCounts(payload: ReadyGatePayload): ReviewGateCountSummary {
  const reviews = payload.reviews ?? [];
  const reviewPolicy = normalizedReviewPolicy(payload);
  const freshness = reviews.map((review) => classifyReviewFreshness(review, payload));
  const freshPassing = reviews.filter((review) => reviewCertifiesPreparedPackage(review, payload));
  const passingReviews = reviews.filter(reviewIsPassing);
  const sessionIds = new Set(
    freshPassing.map((review) => review.reviewerSessionId || review.session?.sessionId),
  );
  return {
    requiredReviews: effectiveRequiredReviewCount(reviewPolicy),
    minimumReviews: reviewPolicy.minimumReviews,
    totalReviews: reviews.length,
    totalAttempts: reviews.reduce(
      (sum, review) => sum + Math.max(1, review.attempts?.length ?? 0),
      0,
    ),
    passingReviews: passingReviews.length,
    freshPassingReviews: freshPassing.length,
    trustedPassingReviews: sessionIds.size,
    staleIgnoredReviews: freshness.filter((entry) => entry.stale).length,
    unresolvedFindings: reviews.reduce((sum, review) => sum + review.unresolvedCount, 0),
    freshness,
  };
}

export interface ReviewRequirementDisplay {
  counts: ReviewGateCountSummary;
  label: string;
  satisfied: boolean;
}

/** Current prepared policy, with old review attempts retained as history. */
export function reviewRequirementDisplay(payload: ReadyGatePayload): ReviewRequirementDisplay {
  const counts = summarizeReviewCounts(payload);
  const satisfied = counts.trustedPassingReviews >= counts.requiredReviews;
  return {
    counts,
    satisfied,
    label:
      counts.requiredReviews === 0
        ? 'No independent review required'
        : `${counts.trustedPassingReviews}/${counts.requiredReviews} passing independent reviews`,
  };
}
