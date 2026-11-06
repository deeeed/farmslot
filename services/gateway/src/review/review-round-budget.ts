import {
  type AgentContext,
  isReviewRoundNoVerdictSettlement,
  isTerminalRunStatus,
  type Principal,
  PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES,
  type ReviewBudgetExtension,
  reviewRoundAdmissionId,
  reviewRoundAdmissionIds,
  reviewRoundAdmissionsInScope,
  type ReviewRoundBudget,
  reviewRoundBudget,
  reviewRoundBudgetForRun,
  type ReviewRoundSettlement,
  reviewRoundSettlementsForRun,
  type Run,
  type RunExtendReviewBudgetParams,
  workspaceReviewRoundAdmissionId,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { publicationStatusForRun } from '../run-completion/publication-status.js';
import { runTransitionCoordinator } from '../run-lifecycle/transition-coordinator.js';
import {
  commitRunReviewBudgetExtension,
  getAllRuns,
  getAllRunsWithArchived,
  getRun,
  persistRunNow,
  updateRun,
} from '../runs/store.js';

import { reviewPRIdentity } from './session-mode.js';

// Launch intent is durable before runner effects. Context-free reservations from
// an earlier gateway cannot represent a live reviewer; current startup gaps can.
const pendingStartups = new Map<string, number>();
const startupKey = (runId: string, admission: string) => JSON.stringify([runId, admission]);
function releasePendingStartup(scope: readonly Run[], admission: string): void {
  for (const run of scope) pendingStartups.delete(startupKey(run.id, admission));
}

export { reviewRoundAdmissionId } from '@farmslot/protocol';

/**
 * The launch time a review attempt's round is admitted under. A review context
 * is created with this time as its `startedAt`, which nothing rewrites (the
 * reviewer's own mark start rewrites `attemptStartedAt`). Relaunching or
 * recovering that same context, for example after a gateway restart before its
 * reviewer started, keys on it again and reuses the round it already reserved.
 */
export function reviewLaunchStartedAt(
  context: Pick<AgentContext, 'startedAt'> | undefined,
  now = new Date().toISOString(),
): string {
  return context?.startedAt ?? now;
}

/**
 * The receipt a native reviewer context was admitted under. Admission keys on the
 * context's launch `startedAt`, not `attemptStartedAt`, which the reviewer's mark
 * start rewrites; only legacy `historicalAdmissions` reads `attemptStartedAt` first.
 */
export function reviewContextRoundId(
  context: Pick<AgentContext, 'id' | 'reviewId' | 'reviewLoopNumber' | 'startedAt'>,
): string | undefined {
  return (
    context.startedAt &&
    reviewRoundAdmissionId(
      context.reviewId ?? context.id,
      context.reviewLoopNumber ?? 1,
      context.startedAt,
    )
  );
}

function scopedRuns(run: Run, stored: readonly Run[]): Run[] {
  const byId = new Map(stored.map((candidate) => [candidate.id, candidate]));
  // Admission reads the live map again after archive IO. Another caller may
  // have reserved the last round while that IO was pending.
  for (const current of getAllRuns()) byId.set(current.id, current);
  byId.set(run.id, getRun(run.id) ?? run);
  const current = byId.get(run.id)!;
  if (current.flowType === 'review-pr') return [current];
  const identity = reviewPRIdentity(current, { requirePRContext: true });
  return identity
    ? [...byId.values()].filter((candidate) => {
        const other = reviewPRIdentity(candidate, { requirePRContext: true });
        return (
          candidate.flowType !== 'review-pr' &&
          (candidate.id === current.id ||
            Boolean(
              other &&
              other.repository.toLowerCase() === identity.repository.toLowerCase() &&
              other.prNumber === identity.prNumber,
            ))
        );
      })
    : [current];
}

function admissionsFor(runs: readonly Run[]): string[] {
  return [...new Set(runs.flatMap((run) => reviewRoundAdmissionIds(run)))];
}

function extensionsFor(runs: readonly Run[]): ReviewBudgetExtension[] {
  return [
    ...new Map(
      runs
        .flatMap((run) => run.reviewBudgetExtensions ?? [])
        .map((entry) => [JSON.stringify([entry.runId, entry.requestId]), entry]),
    ).values(),
  ].sort((a, b) => a.limit - b.limit);
}

function settlementsFor(runs: readonly Run[]): Record<string, ReviewRoundSettlement> {
  const settlements: Record<string, ReviewRoundSettlement> = {};
  const rank = (entry: ReviewRoundSettlement) =>
    entry.kind === 'verdict' ? 2 : entry.kind === 'pending' ? 0 : 1;
  for (const run of runs)
    for (const [id, value] of Object.entries(run.reviewRoundSettlements ?? {})) {
      const previous = settlements[id];
      if (
        !previous ||
        value.at > previous.at ||
        (value.at === previous.at && rank(value) > rank(previous))
      )
        settlements[id] = value;
    }
  // A copied legacy result cannot override an explicit disposition from its owner.
  for (const run of runs)
    for (const [id, value] of Object.entries(reviewRoundSettlementsForRun(run)))
      settlements[id] ??= value;
  return settlements;
}

function ownersFor(runs: readonly Run[]): Record<string, string> {
  return Object.assign({}, ...runs.map((run) => run.reviewRoundOwners ?? {}));
}

// A settlement refunds a round only while its receipt is admitted in scope.
function budgetFrom(
  run: Run,
  admissions: readonly string[],
  extensions: readonly ReviewBudgetExtension[],
  settlements: Record<string, ReviewRoundSettlement>,
  owners: Record<string, string>,
): ReviewRoundBudget {
  return reviewRoundBudgetForRun({
    ...run,
    reviewRoundAdmissions: [...admissions],
    reviewRoundOwners: owners,
    reviewRoundSettlements: settlements,
    reviewBudgetExtensions: [...extensions],
  });
}

function budgetFor(run: Run, runs: readonly Run[]): ReviewRoundBudget {
  return budgetFrom(
    run,
    admissionsFor(runs),
    extensionsFor(runs),
    settlementsFor(runs),
    ownersFor(runs),
  );
}

function budgetScopeKey(run: Run): string {
  const identity =
    run.flowType === 'review-pr' ? null : reviewPRIdentity(run, { requirePRContext: true });
  return identity ? JSON.stringify([identity.repository.toLowerCase(), identity.prNumber]) : run.id;
}

function withBudget<T>(
  runId: string,
  operation: (run: Run, scope: Run[]) => Promise<T>,
): Promise<T> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const key = budgetScopeKey(run);
  return runTransitionCoordinator.withReviewBudget(key, async () => {
    const stored = await getAllRunsWithArchived();
    const current = getRun(runId);
    if (!current || budgetScopeKey(current) !== key) throw new Error('Review budget scope changed');
    return operation(current, scopedRuns(current, stored));
  });
}

/**
 * Why `run.extendReviewBudget` can never grant this run more rounds, or
 * undefined when it can.
 */
export function reviewBudgetExtensionRefusal(run: Run): string | undefined {
  const reason = !['dev', 'fix-bug'].includes(run.flowType)
    ? `is a ${run.flowType} run`
    : run.completionPolicy === 'artifact-only'
      ? 'is an artifact-only run'
      : run.archivedAt
        ? 'is archived'
        : run.readOnly
          ? 'is read-only'
          : publicationStatusForRun(run) !== 'not_published'
            ? 'is already published'
            : undefined;
  return (
    reason &&
    `this run ${reason}; only the unpublished dev or fix-bug run that owns the branch can be granted more review rounds`
  );
}

// A spent budget points at an extension only for a run that can receive one.
function budgetForRun(run: Run, budget: ReviewRoundBudget): ReviewRoundBudget {
  if (run.flowType === 'update-branch') return budget;
  const refusal = budget.diagnosis && reviewBudgetExtensionRefusal(run);
  return refusal
    ? {
        ...budget,
        diagnosis: `All ${budget.limit} review rounds for this work are spent, and ${refusal}. Stop and narrow the change or redesign it.`,
      }
    : budget;
}

export async function runReviewRoundBudget(run: Run): Promise<ReviewRoundBudget> {
  return budgetForRun(run, budgetFor(run, scopedRuns(run, await getAllRunsWithArchived())));
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

/** Pending launches reserve capacity without claiming a completed review round. */
function refuseUnavailableRounds(run: Run, scope: readonly Run[]): void {
  const budget = budgetForRun(run, budgetFor(run, scope));
  refuseSpentBudget(budget);
  const settlements = settlementsFor(scope);
  const inScope = reviewRoundAdmissionsInScope({
    ...run,
    reviewRoundAdmissions: admissionsFor(scope),
    reviewRoundOwners: ownersFor(scope),
  });
  const pending = inScope.filter((id) => {
    const state = settlements[id];
    if (state?.kind === 'verdict' || isReviewRoundNoVerdictSettlement(state)) return false;
    const contexts = scope.flatMap((candidate) =>
      (candidate.agentContexts ?? []).filter((context) => {
        if (
          candidate.reviewWorkspaceSubject &&
          (context.role === 'review' || context.role === 'primary') &&
          workspaceReviewRoundAdmissionId(candidate) === id
        )
          return true;
        return (
          context.role === 'review' &&
          [context.startedAt, context.attemptStartedAt].some(
            (at) =>
              at &&
              reviewRoundAdmissionId(
                context.reviewId ?? context.id,
                context.reviewLoopNumber ?? 1,
                at,
              ) === id,
          )
        );
      }),
    );
    return (
      (contexts.length === 0 &&
        state?.kind === 'pending' &&
        scope.some(
          (owner) =>
            !owner.archivedAt &&
            owner.status !== 'paused' &&
            !isTerminalRunStatus(owner.status) &&
            pendingStartups.get(startupKey(owner.id, id)) === (owner.engineState?.generation ?? 0),
        )) ||
      contexts.some(
        (context) =>
          ['launching', 'working', 'waiting'].includes(context.status) ||
          (!!context.nativeSession &&
            !context.nativeSession.closedAt &&
            !context.nativeSession.releasedAt),
      )
    );
  }).length;
  if (budget.used + pending >= budget.limit)
    throw new GatewayMethodError(
      'REVIEW_ROUND_PENDING',
      'Review capacity is reserved by reviewers awaiting a verdict. Wait for them to finish or resolve their failed launch.',
      { details: { reviewRoundBudget: budget } },
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
  const scope = scopedRuns(run, await getAllRunsWithArchived());
  return {
    ...run,
    reviewRoundSettlements: settlementsFor(scope),
    decisions: decisionsWithBudget(run, budgetForRun(run, budgetFor(run, scope))),
  };
}

export async function assertReviewRoundAvailable(run: Run): Promise<void> {
  refuseUnavailableRounds(run, scopedRuns(run, await getAllRunsWithArchived()));
}

export function reviewBudgetScopeBrief(run: Run): string {
  const budget = budgetFor(run, [run]);
  const pending = Object.values(run.reviewRoundSettlements ?? {}).some(
    (entry) => entry.kind === 'pending',
  );
  return formatReviewBudgetScopeBrief(
    budget.used + (pending ? 1 : 0),
    budget.limit,
    budget.extensions ?? [],
  );
}

/** Static task inputs freeze before dispatch reserves its next admission. */
export async function nextReviewBudgetScopeBrief(run: Run): Promise<string> {
  const budget = await runReviewRoundBudget(run);
  return formatReviewBudgetScopeBrief(budget.used + 1, budget.limit, budget.extensions ?? []);
}

/** States the reviewer's round (project review templates relax blocking from round 3). */
function formatReviewBudgetScopeBrief(
  used: number,
  limit: number,
  extensions: readonly ReviewBudgetExtension[],
): string {
  const extension = [...extensions]
    .reverse()
    .find((entry) => used > entry.previousLimit && used <= entry.limit);
  const roundLimit = extension?.limit ?? limit;
  const round =
    used >= 1 && used <= roundLimit
      ? `\n## Review round\n\nReview round ${used} of ${roundLimit}.\n`
      : '';
  const scope = extension
    ? `\n## Authorized additional-review scope\n\nAttempt ${used}/${extension.limit}, granted by ${extension.principalId} (${extension.principalSubject.type}) at ${extension.approvedAt}. Grant-time head ${extension.headSha} is provenance; review the current captured head on this owned branch.\n\n${extension.scopeBrief}\n\nThis grants review scope only. Retain the immutable input/session and publication contracts.\n`
    : '';
  return round + scope;
}

/** Load history first, then check fresh live state synchronously at consumption. */
export async function prepareReviewRoundAvailabilityCheck(runId: string): Promise<() => void> {
  const stored = await getAllRunsWithArchived();
  return () => {
    const run = getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    refuseUnavailableRounds(run, scopedRuns(run, stored));
  };
}

async function persistScopedRounds(
  scope: readonly Run[],
  admissions: string[],
  settlements: Record<string, ReviewRoundSettlement>,
  owners = ownersFor(scope),
): Promise<void> {
  const extensions = extensionsFor(scope);
  const runs = scope.flatMap((current) => {
    const live = getRun(current.id);
    return live ? [live] : [];
  });
  // Keep the receipts in each existing snapshot so retiring an earlier run
  // does not refund its rounds while this PR still has a surviving run.
  for (const current of runs) {
    updateRun(current.id, {
      reviewRoundAdmissions: admissions,
      ...(Object.keys(owners).length ? { reviewRoundOwners: owners } : {}),
      ...(extensions.length ? { reviewBudgetExtensions: extensions } : {}),
      ...(Object.keys(settlements).length || current.reviewRoundSettlements
        ? { reviewRoundSettlements: settlements }
        : {}),
      decisions: decisionsWithBudget(
        current,
        budgetForRun(current, budgetFrom(current, admissions, extensions, settlements, owners)),
      ),
    });
  }
  await Promise.all(runs.map((current) => persistRunNow(getRun(current.id)!)));
}

/** Reserve synchronously from fresh state, then persist before any runner launch. */
export async function admitReviewRound(runId: string, attemptId: string): Promise<void> {
  return withBudget(runId, async (run, scope) => {
    const admissions = admissionsFor(scope);
    const owners = ownersFor(scope);
    // A receipt admitted again (a reattach) is the same attempt and keeps its settlement.
    if (!admissions.includes(attemptId)) {
      refuseUnavailableRounds(run, scope);
      admissions.push(attemptId);
      if (run.flowType === 'update-branch') owners[attemptId] = run.id;
    }
    const settlements = settlementsFor(scope);
    if (!settlements[attemptId])
      settlements[attemptId] = {
        kind: 'pending',
        reason: 'Waiting for reviewer verdict',
        at: new Date().toISOString(),
      };
    await persistScopedRounds(scope, admissions, settlements, owners);
    if (settlements[attemptId]?.kind === 'pending')
      pendingStartups.set(startupKey(run.id, attemptId), run.engineState?.generation ?? 0);
  });
}

/**
 * Settle an admitted attempt that ended without a pass or issues verdict, so it
 * spends no round (ADR-063 Amendment 2). Each attempt settles once: a receipt
 * that was never admitted or is already settled is left as it is.
 */
export async function settleReviewRoundNoVerdict(
  runId: string,
  attemptId: string,
  reason: string,
  kind?: 'infrastructure-fallback',
): Promise<void> {
  // A deleted run has no budget scope left to record into.
  if (!getRun(runId)) return;
  return withBudget(runId, async (_run, scope) => {
    const admissions = admissionsFor(scope);
    const settlements = settlementsFor(scope);
    if (
      !admissions.includes(attemptId) ||
      isReviewRoundNoVerdictSettlement(settlements[attemptId]) ||
      settlements[attemptId]?.kind === 'verdict'
    )
      return;
    settlements[attemptId] = { reason, at: new Date().toISOString(), ...(kind ? { kind } : {}) };
    await persistScopedRounds(scope, admissions, settlements);
    releasePendingStartup(scope, attemptId);
  });
}

/** A settled attempt whose pass or issues verdict recovery later ingested counts again. */
export async function recordReviewRoundVerdict(
  runId: string,
  attemptId: string,
  review?: Pick<AgentContext, 'reviewFallback'>,
): Promise<void> {
  if (!getRun(runId)) return;
  return withBudget(runId, async (_run, scope) => {
    const settlements = settlementsFor(scope);
    const settled = settlements[attemptId];
    if (
      settled?.kind === 'verdict' &&
      scope.some(
        (run) =>
          run.reviewRoundSettlements?.[attemptId]?.kind === 'verdict' &&
          run.reviewRoundSettlements[attemptId]?.at === settled.at,
      )
    )
      return;
    // A farm replacement shares the failed WARM launch's admission. Its valid
    // verdict cannot turn that explicitly free replacement back into a paid round.
    if (
      admissionsFor(scope).includes(attemptId) &&
      !(
        settled?.kind === 'infrastructure-fallback' &&
        review?.reviewFallback?.reason === 'session-unavailable'
      )
    ) {
      settlements[attemptId] = {
        kind: 'verdict',
        reason: 'Reviewer verdict recorded',
        at: new Date().toISOString(),
      };
      await persistScopedRounds(scope, admissionsFor(scope), settlements);
      releasePendingStartup(scope, attemptId);
    }
  });
}

/**
 * Why the automatic launch paths (restart recovery, review-sequence
 * continuation, the re-review after a fix) must stop starting reviewers for
 * this work, or undefined below the no-verdict cap. Operator requests still launch.
 */
export async function reviewNoVerdictCapReason(run: Run): Promise<string | undefined> {
  const scope = scopedRuns(run, await getAllRunsWithArchived());
  const budget = budgetFor(run, scope);
  if (budget.noVerdict < budget.noVerdictLimit) return undefined;
  const settlements = settlementsFor(scope);
  const last = reviewRoundAdmissionsInScope({
    ...run,
    reviewRoundAdmissions: admissionsFor(scope),
    reviewRoundOwners: ownersFor(scope),
  })
    .flatMap((id) => (isReviewRoundNoVerdictSettlement(settlements[id]) ? [settlements[id]!] : []))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-budget.noVerdictLimit)
    .map((entry) => entry.reason);
  return `${budget.noVerdict}/${budget.noVerdictLimit} reviewer attempts ended without a verdict, so automatic reviews stopped. Request a review to retry. Last: ${last.join('; ')}`;
}

export function extendReviewRoundBudget(
  params: RunExtendReviewBudgetParams,
  principal: Principal,
  assertCurrent: (run: Run) => Promise<void>,
): Promise<{ receipt: ReviewBudgetExtension; budget: ReviewRoundBudget }> {
  return withBudget(params.runId, async (run, scope) => {
    const extensions = extensionsFor(scope);
    const prior = extensions.find(
      (entry) => entry.runId === run.id && entry.requestId === params.requestId,
    );
    if (prior) {
      if (
        prior.previousLimit !== params.expectedLimit ||
        prior.limit !== params.limit ||
        prior.headSha !== params.headSha ||
        prior.scopeBrief !== params.scopeBrief ||
        prior.principalId !== principal.id ||
        JSON.stringify(prior.principalSubject) !== JSON.stringify(principal.subject)
      )
        throw new Error('Review budget request ID already records a different grant');
      return { receipt: prior, budget: budgetFor(run, scope) };
    }
    const budget = budgetFor(run, scope);
    if (params.expectedLimit !== budget.limit)
      throw new Error(
        `Review budget changed; expected ${params.expectedLimit}, current ${budget.limit}`,
      );
    if (
      !Number.isSafeInteger(params.limit) ||
      params.limit <= budget.limit ||
      params.limit > budget.limit + 5
    )
      throw new Error('A review budget grant must add between one and five rounds');
    await assertCurrent(run);
    const identity = reviewPRIdentity(run, { requirePRContext: true });
    const receipt: ReviewBudgetExtension = {
      requestId: params.requestId,
      runId: run.id,
      project: run.project,
      branch: run.branch!,
      ...(identity ? { repository: identity.repository, prNumber: identity.prNumber } : {}),
      headSha: params.headSha,
      previousLimit: budget.limit,
      limit: params.limit,
      scopeBrief: params.scopeBrief,
      principalId: principal.id,
      principalSubject: structuredClone(principal.subject),
      approvedAt: new Date().toISOString(),
    };
    await commitRunReviewBudgetExtension(run.id, receipt, assertCurrent);
    const nextExtensions = [...extensions, receipt];
    const nextBudget = reviewRoundBudget(budget.used, nextExtensions, budget.noVerdict);
    const live = scope.flatMap((entry) => (getRun(entry.id) ? [getRun(entry.id)!] : []));
    for (const current of live) {
      const gate = current.engineState?.publishGate;
      const currentBudget = budgetForRun(
        current,
        budgetFrom(
          current,
          admissionsFor(scope),
          nextExtensions,
          settlementsFor(scope),
          ownersFor(scope),
        ),
      );
      updateRun(current.id, {
        reviewBudgetExtensions: nextExtensions,
        decisions: decisionsWithBudget(current, currentBudget),
        ...(currentBudget.remaining &&
        gate?.reviewLaunchRejection?.code === 'REVIEW_ROUND_LIMIT_REACHED'
          ? {
              engineState: {
                ...current.engineState,
                publishGate: { ...gate, reviewLaunchRejection: undefined },
              },
            }
          : {}),
      });
    }
    await Promise.all(live.map((entry) => persistRunNow(getRun(entry.id)!)));
    return { receipt, budget: nextBudget };
  });
}
