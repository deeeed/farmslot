import type {
  ReviewAttempt,
  ReviewBudgetExtension,
  ReviewRoundBudget,
  ReviewRoundSettlement,
  ReviewStatus,
  Run,
} from '../contracts/runs.js';
import { isRecord } from '../recipe/common.js';

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
> &
  Partial<
    Pick<
      Run,
      | 'createdAt'
      | 'agentContexts'
      | 'engineState'
      | 'steps'
      | 'reviewWorkspaceSubject'
      | 'reviewResult'
    >
  >;

export function reviewRoundAdmissionId(
  reviewId: string,
  loopNumber: number,
  startedAt: string,
): string {
  return JSON.stringify([reviewId, loopNumber, startedAt]);
}

export function workspaceReviewRoundAdmissionId(
  run: Pick<Run, 'id'> & Partial<Pick<Run, 'createdAt' | 'engineState'>>,
  generation = run.engineState?.workspaceReviewDispatchGeneration ??
    run.engineState?.generation ??
    0,
): string {
  return reviewRoundAdmissionId(
    `workspace-review-${run.id}`,
    generation + 1,
    run.createdAt ?? 'historical',
  );
}

export function reviewRoundAdmissionIds(
  run: ReviewRoundBudgetSource,
  verdictOnly = false,
): string[] {
  if (run.reviewRoundAdmissions && !verdictOnly) return run.reviewRoundAdmissions;
  const ids = new Set<string>();
  const add = (reviewId: string, attempt: Partial<ReviewAttempt>, fallback?: string) => {
    const lineage = attempt.session?.reviewId ?? reviewId;
    const loop = attempt.loopNumber ?? 1;
    // Older result timestamps can describe completion. The matching context
    // records launch, so both records must identify that same round.
    const candidates = [...(run.agentContexts ?? [])]
      .reverse()
      .filter(
        (candidate) =>
          candidate.role === 'review' &&
          (candidate.reviewId ?? candidate.id) === lineage &&
          (candidate.reviewLoopNumber ?? 1) === loop,
      );
    const at = attempt.startedAt ?? fallback;
    const context =
      candidates.find(
        (candidate) => at && (candidate.startedAt === at || candidate.attemptStartedAt === at),
      ) ?? candidates[0];
    if (verdictOnly && context && !context.reviewResultValidatedAt && context.status !== 'complete')
      return;
    const times = [
      context?.startedAt,
      context?.attemptStartedAt,
      attempt.startedAt,
      fallback,
    ].filter((v): v is string => !!v);
    const recorded = times
      .map((time) => reviewRoundAdmissionId(lineage, loop, time))
      .find((id) => run.reviewRoundAdmissions?.includes(id));
    ids.add(
      recorded ??
        reviewRoundAdmissionId(
          lineage,
          loop,
          context?.attemptStartedAt ??
            context?.startedAt ??
            attempt.startedAt ??
            fallback ??
            'historical',
        ),
    );
  };
  for (const review of run.engineState?.publishGate?.reviews ?? []) {
    if (review.verdict === 'skipped') continue;
    // Older rows kept the publication row id, while their context kept the lineage.
    const lineage =
      review.session?.reviewId ??
      (review.reviewerSessionId
        ? run.agentContexts?.find(
            (context) =>
              context.role === 'review' &&
              context.runId === run.id &&
              context.artifactScope === review.id &&
              context.runnerSessionId === review.reviewerSessionId,
          )?.reviewId
        : undefined) ??
      review.id;
    for (const attempt of review.attempts?.length ? review.attempts : [review]) {
      if (
        verdictOnly
          ? ['pass', 'issues'].includes(attempt.verdict ?? '')
          : attempt.verdict !== 'skipped'
      )
        add(lineage, attempt, review.startedAt);
    }
  }
  const pipeline = run.steps?.find((step) => step.name === 'review')?.outputs;
  if (pipeline && Array.isArray(pipeline.attempts)) {
    for (const value of pipeline.attempts) {
      if (!isRecord(value)) continue;
      const attempt: Partial<ReviewAttempt> = {
        ...(typeof value.loopNumber === 'number' ? { loopNumber: value.loopNumber } : {}),
        ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
      };
      const verdict = value.verdict;
      if (
        verdict === 'pending' ||
        verdict === 'pass' ||
        verdict === 'issues' ||
        verdict === 'failed' ||
        verdict === 'cancelled' ||
        verdict === 'skipped'
      )
        attempt.verdict = verdict;
      if (
        verdictOnly
          ? ['pass', 'issues'].includes(attempt.verdict ?? '')
          : attempt.verdict !== 'skipped'
      )
        add(
          isRecord(value.session) && typeof value.session.reviewId === 'string'
            ? value.session.reviewId
            : typeof pipeline.reviewId === 'string'
              ? pipeline.reviewId
              : `pipeline-review-${run.id}`,
          attempt,
        );
    }
  }
  for (const context of run.agentContexts ?? []) {
    if (
      (context.role !== 'review' && !(context.role === 'primary' && run.reviewWorkspaceSubject)) ||
      !(context.attemptStartedAt ?? context.startedAt)
    )
      continue;
    if (context.role === 'primary' && run.reviewWorkspaceSubject) {
      if (verdictOnly && !run.reviewResult) continue;
      ids.add(workspaceReviewRoundAdmissionId(run));
      continue;
    }
    if (verdictOnly && !context.reviewResultValidatedAt) continue;
    add(context.reviewId ?? context.id, {
      loopNumber: context.reviewLoopNumber ?? 1,
      startedAt: context.attemptStartedAt ?? context.startedAt,
    });
  }
  return [...ids];
}

export function isReviewRoundNoVerdictSettlement(
  value: ReviewRoundSettlement | undefined,
): boolean {
  return !!value && value.kind !== 'pending' && value.kind !== 'verdict';
}

/** Retained validated results seed old receipts; an unreturned launch never becomes a verdict. */
export function reviewRoundSettlementsForRun(
  run: ReviewRoundBudgetSource,
): Record<string, ReviewRoundSettlement> {
  const states = { ...run.reviewRoundSettlements };
  const admitted = new Set(reviewRoundAdmissionIds(run));
  for (const id of reviewRoundAdmissionIds(run, true)) {
    if (
      !admitted.has(id) ||
      states[id]?.kind === 'verdict' ||
      states[id]?.kind === 'infrastructure-fallback'
    )
      continue;
    const validated = run.agentContexts?.find(
      (context) =>
        context.role === 'review' &&
        context.reviewResultValidatedAt &&
        [context.startedAt, context.attemptStartedAt].some(
          (at) =>
            at &&
            reviewRoundAdmissionId(
              context.reviewId ?? context.id,
              context.reviewLoopNumber ?? 1,
              at,
            ) === id,
        ),
    );
    // A validated result survives a crash before its pending/refund disposition is updated.
    // A copied legacy row alone must not override an explicit disposition.
    if (states[id] && !validated?.reviewResultValidatedAt) continue;
    states[id] = {
      kind: 'verdict',
      reason: 'Recorded reviewer verdict',
      at: validated?.reviewResultValidatedAt ?? validated?.completedAt ?? '',
    };
  }
  return states;
}

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
  const settlements = reviewRoundSettlementsForRun(run);
  const noVerdict = admissions.filter((id) =>
    isReviewRoundNoVerdictSettlement(settlements[id]),
  ).length;
  const used = admissions.filter((id) => settlements[id]?.kind === 'verdict').length;
  const maintenance = run.flowType === 'update-branch';
  return reviewRoundBudget(
    used,
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
