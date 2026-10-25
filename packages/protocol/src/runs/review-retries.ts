import type {
  ReviewBudgetExtension,
  ReviewRoundBudget,
  ReviewStatus,
  Run,
} from '../contracts/runs.js';

export const MAX_REVIEW_ROUNDS = 5;
export const MAX_UPDATE_BRANCH_REVIEW_ROUNDS = 2;
/** No-verdict reviewer attempts after which automatic review launches stop (ADR-063 Amendment 2). */
export const REVIEW_NO_VERDICT_LIMIT = 3;

export type ReviewRoundBudgetSource = Pick<
  Run,
  | 'id'
  | 'flowType'
  | 'reviewRoundAdmissions'
  | 'reviewRoundOwners'
  | 'reviewRoundSettlements'
  | 'reviewBudgetExtensions'
>;

/** Scope normalized receipts without changing their opaque identity. */
export function reviewRoundAdmissionsInScope(run: ReviewRoundBudgetSource): string[] {
  return [...new Set(run.reviewRoundAdmissions ?? [])].filter((id) =>
    run.flowType === 'update-branch'
      ? run.reviewRoundOwners?.[id] === run.id
      : !run.reviewRoundOwners?.[id],
  );
}

/** Shared gateway/client projection from durable admission and settlement metadata. */
export function reviewRoundBudgetForRun(run: ReviewRoundBudgetSource): ReviewRoundBudget {
  const admissions = reviewRoundAdmissionsInScope(run);
  const noVerdict = admissions.filter((id) => run.reviewRoundSettlements?.[id]).length;
  const maintenance = run.flowType === 'update-branch';
  return reviewRoundBudget(
    admissions.length - noVerdict,
    maintenance ? [] : (run.reviewBudgetExtensions ?? []),
    noVerdict,
    maintenance ? MAX_UPDATE_BRANCH_REVIEW_ROUNDS : MAX_REVIEW_ROUNDS,
  );
}

/** Round budget is separate from the number of qualifying passing reviewers. */
export function reviewRoundBudget(
  used: number,
  extensions: readonly ReviewBudgetExtension[] = [],
  noVerdict = 0,
  baseLimit: typeof MAX_REVIEW_ROUNDS | typeof MAX_UPDATE_BRANCH_REVIEW_ROUNDS = MAX_REVIEW_ROUNDS,
): ReviewRoundBudget {
  const count = Number.isFinite(used) ? Math.max(0, Math.floor(used)) : 0;
  const limit = Math.max(baseLimit, ...extensions.map((entry) => entry.limit));
  return {
    used: count,
    limit,
    remaining: Math.max(0, limit - count),
    label: `Review rounds ${count}/${limit}`,
    noVerdict: Number.isFinite(noVerdict) ? Math.max(0, Math.floor(noVerdict)) : 0,
    noVerdictLimit: REVIEW_NO_VERDICT_LIMIT,
    ...(extensions.length
      ? {
          extensions: [...extensions],
          extensionSummary: extensions
            .map(
              (entry) =>
                `${entry.previousLimit} → ${entry.limit}, ${entry.principalId}, ${entry.approvedAt}: ${entry.scopeBrief}`,
            )
            .join('\n'),
        }
      : {}),
    ...(count >= limit
      ? {
          diagnosis:
            limit === MAX_UPDATE_BRANCH_REVIEW_ROUNDS
              ? 'All 2 review rounds for this update-branch run are spent. Stop and narrow the branch update.'
              : limit === MAX_REVIEW_ROUNDS
                ? 'The five review rounds are spent. A design problem or scope creep has exhausted the review budget; stop and narrow the change or redesign it.'
                : `All ${limit} authorized review rounds are spent; stop and narrow the change or request a lead-approved scoped extension.`,
        }
      : {}),
  };
}

/** The gate's budget line: the round label, plus no-verdict attempts once there are any. */
export function reviewRoundBudgetLabel(budget: ReviewRoundBudget): string {
  return budget.noVerdict > 0
    ? `${budget.label} · ${budget.noVerdict}/${budget.noVerdictLimit} no-verdict`
    : budget.label;
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
