import type { ReviewAttempt, ReviewStatus } from '../contracts/runs.js';
import { digestRecipeDocument } from '../recipe/digest.js';
import type { ReviewIssue } from '../recipes/step-io.js';

/** Stable across package refresh and duplicate materialization of the same finding. */
export function reviewFindingId(reviewId: string, headSha: string, issue: ReviewIssue): string {
  return digestRecipeDocument({
    reviewId,
    headSha,
    file: issue.file,
    line: issue.line ?? null,
    description: issue.description,
  });
}

export function reviewFindingIsSettled(
  review: ReviewStatus,
  entry: ReviewStatus | ReviewAttempt,
  issue: ReviewIssue,
): boolean {
  const head =
    entry === review
      ? (review.reviewedHeadSha ?? review.reviewSnapshot?.headSha)
      : entry.reviewSnapshot?.headSha;
  return Boolean(
    head &&
    review.settledFindings?.some(
      (settlement) =>
        settlement.headSha === head &&
        settlement.reviewId === review.id &&
        !!settlement.receiptId &&
        !!settlement.claimId &&
        settlement.findingId === reviewFindingId(review.id, head, issue),
    ),
  );
}

export function openReviewFindingCount(
  review: ReviewStatus,
  entry: ReviewStatus | ReviewAttempt = review,
): number {
  // A validated pass can retain permitted advisory findings without reopening work.
  if (entry.verdict === 'pass' && entry.unresolvedCount === 0) return 0;
  const issues = entry.issues ?? [];
  return (
    Math.max(entry.unresolvedCount ?? 0, issues.length) -
    issues.filter((issue) => reviewFindingIsSettled(review, entry, issue)).length
  );
}

/** A person's evidence decision satisfies those findings without rewriting ISSUES as PASS. */
export function reviewFindingsSatisfied(review: ReviewStatus): boolean {
  return (
    (review.verdict === 'pass' && review.unresolvedCount === 0) ||
    (review.verdict === 'issues' && !!review.issues?.length && openReviewFindingCount(review) === 0)
  );
}
