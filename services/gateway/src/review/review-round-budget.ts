import {
  PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES,
  type ReviewAttempt,
  type ReviewRoundBudget,
  reviewRoundBudget,
  type Run,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import {
  getAllRuns,
  getAllRunsWithArchived,
  getRun,
  persistRunNow,
  updateRun,
} from '../runs/store.js';

import { reviewPRIdentity } from './session-mode.js';

export function reviewRoundAdmissionId(
  reviewId: string,
  loopNumber: number,
  startedAt: string,
): string {
  return JSON.stringify([reviewId, loopNumber, startedAt]);
}

function historicalAdmissions(run: Run): string[] {
  if (run.reviewRoundAdmissions) return run.reviewRoundAdmissions;
  const ids = new Set<string>();
  const add = (reviewId: string, attempt: Partial<ReviewAttempt>, fallback?: string) => {
    const lineage = attempt.session?.reviewId ?? reviewId;
    const loop = attempt.loopNumber ?? 1;
    // Older result timestamps can describe completion. The matching context
    // records launch, so both records must identify that same round.
    const context = [...(run.agentContexts ?? [])]
      .reverse()
      .find(
        (candidate) =>
          candidate.role === 'review' &&
          (candidate.reviewId ?? candidate.id) === lineage &&
          (candidate.reviewLoopNumber ?? 1) === loop,
      );
    ids.add(
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
    for (const attempt of review.attempts?.length ? review.attempts : [review]) {
      if (attempt.verdict !== 'skipped')
        add(review.session?.reviewId ?? review.id, attempt, review.startedAt);
    }
  }
  const pipeline = run.steps.find((step) => step.name === 'review')?.outputs;
  if (pipeline && Array.isArray(pipeline.attempts)) {
    for (const attempt of pipeline.attempts as ReviewAttempt[]) {
      if (attempt.verdict !== 'skipped')
        add(
          typeof pipeline.reviewId === 'string' ? pipeline.reviewId : `pipeline-review-${run.id}`,
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
      add(`workspace-review-${run.id}`, { loopNumber: 1, startedAt: run.createdAt });
      continue;
    }
    add(context.reviewId ?? context.id, {
      loopNumber: context.reviewLoopNumber ?? 1,
      startedAt: context.attemptStartedAt ?? context.startedAt,
    });
  }
  return [...ids];
}

function scopedRuns(run: Run, stored: readonly Run[]): Run[] {
  const byId = new Map(stored.map((candidate) => [candidate.id, candidate]));
  // Admission reads the live map again after archive IO. Another caller may
  // have reserved the last round while that IO was pending.
  for (const current of getAllRuns()) byId.set(current.id, current);
  byId.set(run.id, getRun(run.id) ?? run);
  const current = byId.get(run.id)!;
  const identity = reviewPRIdentity(current, { requirePRContext: true });
  return identity
    ? [...byId.values()].filter((candidate) => {
        const other = reviewPRIdentity(candidate, { requirePRContext: true });
        return (
          candidate.id === current.id ||
          Boolean(
            other &&
            other.repository.toLowerCase() === identity.repository.toLowerCase() &&
            other.prNumber === identity.prNumber,
          )
        );
      })
    : [current];
}

function admissionsFor(runs: readonly Run[]): string[] {
  return [...new Set(runs.flatMap(historicalAdmissions))];
}

export async function runReviewRoundBudget(run: Run): Promise<ReviewRoundBudget> {
  return reviewRoundBudget(admissionsFor(scopedRuns(run, await getAllRunsWithArchived())).length);
}

function refuseSpentBudget(budget: ReviewRoundBudget): void {
  if (!budget.remaining)
    throw new GatewayMethodError(
      PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.roundLimitReached,
      budget.diagnosis!,
      {
        userAction: 'Stop review work. Diagnose the remaining design or scope problem.',
        details: { reviewRoundBudget: budget },
      },
    );
}

function decisionsWithBudget(run: Run, budget: ReviewRoundBudget): Run['decisions'] {
  return run.decisions.map((decision) =>
    !decision.resolvedAt && decision.payload?.kind === 'ready'
      ? { ...decision, payload: { ...decision.payload, reviewRoundBudget: budget } }
      : decision,
  );
}

/** Backfill display metadata without changing a captured package or resolved gate. */
export async function attachReviewRoundBudget(run: Run): Promise<Run> {
  if (!run.decisions.some((decision) => !decision.resolvedAt && decision.payload?.kind === 'ready'))
    return run;
  return { ...run, decisions: decisionsWithBudget(run, await runReviewRoundBudget(run)) };
}

export async function assertReviewRoundAvailable(run: Run): Promise<void> {
  refuseSpentBudget(await runReviewRoundBudget(run));
}

/** Load history first, then check fresh live state synchronously at consumption. */
export async function prepareReviewRoundAvailabilityCheck(runId: string): Promise<() => void> {
  const stored = await getAllRunsWithArchived();
  return () => {
    const run = getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    refuseSpentBudget(reviewRoundBudget(admissionsFor(scopedRuns(run, stored)).length));
  };
}

/** Reserve synchronously from fresh state, then persist before any runner launch. */
export async function admitReviewRound(runId: string, attemptId: string): Promise<void> {
  const stored = await getAllRunsWithArchived();
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const scope = scopedRuns(run, stored);
  const admissions = admissionsFor(scope);
  if (!admissions.includes(attemptId)) {
    refuseSpentBudget(reviewRoundBudget(admissions.length));
    admissions.push(attemptId);
  }
  const budget = reviewRoundBudget(admissions.length);
  const runs = scope.flatMap((current) => {
    const live = getRun(current.id);
    return live ? [live] : [];
  });
  // Keep the receipts in each existing snapshot so retiring an earlier run
  // does not refund its rounds while this PR still has a surviving run.
  for (const current of runs) {
    updateRun(current.id, {
      reviewRoundAdmissions: admissions,
      decisions: decisionsWithBudget(current, budget),
    });
  }
  await Promise.all(runs.map((current) => persistRunNow(getRun(current.id)!)));
}
