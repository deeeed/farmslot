import path from 'node:path';

import {
  type AgentContext,
  effectiveRequiredReviewCount,
  isQualifyingReview,
  parseGitHubRef,
  qualifyingPassingReviews,
  type ReviewPolicy,
  type ReviewRequestContext,
  type ReviewSelection,
  type ReviewSequence,
  type ReviewStatus,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';
import {
  assertWarmReviewContext,
  executionModelFromSelection,
  parseReviewRequestContext,
  parseReviewSelection,
  resolveReviewDispatchDefaults,
  resolveReviewMode,
  reviewContextFromRequest,
  reviewSequenceFromRequest,
} from '@farmslot/review-dispatch';

import {
  resolveWarmReviewerSession,
  reviewPRIdentity,
  WarmReviewRefusal,
} from '../review/session-mode.js';
import { runnerSupportsSessionReload } from '../runners/launch-command.js';
import { normalizeRunner } from '../runners/registry.js';

import { isHumanGateReviewRequestAction } from './decision-replay.js';

export const MAX_PUBLISH_GATE_REVIEW_LOOPS = 5;

export function reviewPlanFromSelection(
  selectionData: Record<string, unknown> | undefined,
): ReviewSequence {
  if (!selectionData?.reviewRequest) return [];
  return reviewSequenceFromRequest(selectionData.reviewRequest, {
    maxRows: MAX_PUBLISH_GATE_REVIEW_LOOPS,
  });
}

export function effectiveReviewRunner(selection: ReviewSelection): string {
  return normalizeRunner(selection.runner);
}

export function reviewerContextEffort(
  context: Pick<AgentContext, 'effort'> & { nativeSession?: { effort?: string } },
): string | null {
  return context.effort?.trim() || context.nativeSession?.effort?.trim() || null;
}

export function requestedReviewLoopCount(
  request: Record<string, unknown>,
  fallbackCount = 1,
): number {
  return Object.keys(request).length
    ? reviewSequenceFromRequest(request, { maxRows: MAX_PUBLISH_GATE_REVIEW_LOOPS }).length
    : fallbackCount;
}

/** Pipeline and gate reviews consume the same separate-session review budget. */
export function automaticPublicationReviewPlan(
  policy: ReviewPolicy,
  reviews: ReviewStatus[],
  defaults = resolveReviewDispatchDefaults(undefined, 'review-pr'),
): ReviewSequence {
  const passingSessions = new Set(
    qualifyingPassingReviews(reviews).map((review) => review.reviewerSessionId),
  );
  const missing = Math.max(0, effectiveRequiredReviewCount(policy) - passingSessions.size);
  const selection = parseReviewSelection({ ...defaults, mode: resolveReviewMode() });
  return Array.from({ length: missing }, () => ({ ...selection }));
}

export function remainingExplicitReviewPlan(
  plan: ReviewSequence,
  reviews: ReviewStatus[],
  scope: { requestedAt?: string; source?: ReviewStatus['source'] } = {},
): ReviewSequence {
  const requestedAt = scope.requestedAt ? Date.parse(scope.requestedAt) : Number.NaN;
  const sessions = new Set<string>();
  const passing = reviews.filter((review) => {
    if (
      !isQualifyingReview(review) ||
      review.verdict !== 'pass' ||
      review.unresolvedCount !== 0 ||
      (scope.source && review.source !== scope.source) ||
      (Number.isFinite(requestedAt) && Date.parse(review.completedAt ?? '') < requestedAt) ||
      sessions.has(review.reviewerSessionId!)
    )
      return false;
    sessions.add(review.reviewerSessionId!);
    return true;
  });
  let completed = 0;
  for (const selection of plan) {
    const execution = executionModelFromSelection(selection);
    const index = passing.findIndex(
      (review) =>
        normalizeRunner(review.runner) === normalizeRunner(selection.runner) &&
        (review.model ?? execution.model) === execution.model &&
        (review.effort ?? execution.effort) === execution.effort,
    );
    if (index < 0) break;
    passing.splice(index, 1);
    completed++;
  }
  return plan.slice(completed);
}

/**
 * ADR-063 Amendment 3: the pipeline review ran the dispatch's first row, so its
 * pass of the gate head is that row's result. It never stands for a later row.
 */
export function pipelineReviewSatisfiesFirstRow(
  plan: ReviewSequence,
  reviews: ReviewStatus[],
  scope: { headSha?: string; requestedAt?: string },
): boolean {
  return (
    !!scope.headSha &&
    plan.length > 0 &&
    remainingExplicitReviewPlan(
      plan.slice(0, 1),
      reviews.filter((review) => review.reviewedHeadSha === scope.headSha),
      { requestedAt: scope.requestedAt, source: 'pipeline' },
    ).length === 0
  );
}

export function humanGateReviewPolicy(
  basePolicy: ReviewPolicy,
  request: Record<string, unknown>,
  options: { actionId?: string; fallbackLoopCount?: number } = {},
): ReviewPolicy {
  return {
    minimumReviews: Math.max(
      basePolicy.minimumReviews,
      requestedReviewLoopCount(request, options.fallbackLoopCount),
    ),
    requestedBy: 'human-gate',
  };
}

export function humanGateReviewRequestFromDecision(
  decision: RunDecision | undefined,
): Record<string, unknown> {
  return (decision?.selectionData?.reviewRequest as Record<string, unknown>) ?? {};
}

export function latestResolvedHumanGateReviewRequestDecision(
  decisions: readonly RunDecision[],
  gateAction?: string,
): RunDecision | undefined {
  return decisions
    .filter(
      (decision) =>
        decision.type === 'engine_human_gate' &&
        !!decision.resolvedAt &&
        isHumanGateReviewRequestAction(decision.resolvedAction) &&
        (!gateAction || decision.resolvedAction === gateAction),
    )
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))[0];
}

export function resolveHumanGateReviewExecutionPlan(input: {
  gateAction: string;
  pendingPlan: readonly ReviewSelection[];
  decisions: readonly RunDecision[];
}): ReviewSequence {
  if (!isHumanGateReviewRequestAction(input.gateAction)) return [...input.pendingPlan];
  const decision = latestResolvedHumanGateReviewRequestDecision(input.decisions, input.gateAction);
  return decision ? reviewPlanFromSelection(decision.selectionData) : [...input.pendingPlan];
}

export interface RecoveryReviewPlan {
  sequence: ReviewSequence;
  context?: ReviewRequestContext;
  note?: string;
  requestedAt?: string;
}

/** Repair historical recovery rows through the operator's original request. */
export function repairUnboundRecoveryReviewPlan(
  run: Run,
  headSha: string | undefined,
): RecoveryReviewPlan | undefined {
  const gate = run.engineState?.publishGate;
  const sequence = gate?.reviewSequence ?? [];
  const context = gate?.reviewSequenceContext;
  if (!sequence.some((row, index) => row.mode === 'warm' && !context?.reviewLineages[index]))
    return undefined;
  const request = latestResolvedHumanGateReviewRequestDecision(run.decisions);
  const original = request ? reviewPlanFromSelection(request.selectionData) : [];
  const originalContext = request?.selectionData?.reviewRequest
    ? reviewContextFromRequest(request.selectionData.reviewRequest)
    : undefined;
  if (original.length && headSha) {
    const remaining = remainingExplicitReviewPlan(
      original,
      (gate?.reviews ?? []).filter((review) => review.reviewedHeadSha === headSha),
      { requestedAt: request?.resolvedAt },
    );
    const remainingContext = originalContext
      ? { reviewLineages: originalContext.reviewLineages.slice(original.length - remaining.length) }
      : undefined;
    if (
      !remaining.some(
        (row, index) => row.mode === 'warm' && !remainingContext?.reviewLineages[index],
      )
    )
      return {
        sequence: remaining,
        context: remainingContext,
        requestedAt: request?.resolvedAt,
        note: 'Recovered remaining reviewers from the original gate request; current-head native reviews are retained.',
      };
  }
  // Older complete replays deleted the request decision. Recover the missing
  // choices from retained reviewer contexts, within the attested extension.
  const grants = (run.reviewBudgetExtensions ?? [])
    .filter((grant) => grant.headSha === headSha)
    .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
  if (headSha && grants.length && gate?.reviewPolicy) {
    const passed = qualifyingPassingReviews(
      (gate.reviews ?? []).filter(
        (review) =>
          review.reviewedHeadSha === headSha &&
          Date.parse(review.completedAt ?? '') >= Date.parse(grants[0].approvedAt),
      ),
    );
    const sessions = new Set(passed.map((review) => review.reviewerSessionId));
    const seenChoices = new Set<string>();
    const choices: ReviewSequence = (run.agentContexts ?? [])
      .filter((candidate) => candidate.role === 'review' && candidate.runner)
      .sort(
        (a, b) => Number(sessions.has(b.runnerSessionId)) - Number(sessions.has(a.runnerSessionId)),
      )
      .map<ReviewSelection>((candidate) => ({
        runner: normalizeRunner(candidate.runner),
        model: candidate.model ?? null,
        effort: reviewerContextEffort(candidate),
        mode: 'cold',
      }))
      .filter((choice) => {
        const key = JSON.stringify([choice.runner, choice.model, choice.effort]);
        if (seenChoices.has(key)) return false;
        seenChoices.add(key);
        return true;
      });
    const missing = Math.max(0, effectiveRequiredReviewCount(gate.reviewPolicy) - sessions.size);
    if (choices.length)
      return {
        sequence: remainingExplicitReviewPlan(choices, passed).slice(0, missing),
        requestedAt: grants[0].approvedAt,
        note: 'WARM recovery lost its request lineage. Using COLD for the remaining retained reviewer choices; scoped current-head native PASS is preserved.',
      };
  }
  return {
    sequence: sequence.map((row, index) =>
      row.mode === 'warm' && !context?.reviewLineages[index] ? { ...row, mode: 'cold' } : row,
    ),
    context,
    requestedAt: gate?.reviewSequenceRequestedAt,
    note: 'WARM recovery has no reviewId lineage context. Using COLD review on the same run; prior reviews remain retained.',
  };
}

export function recoveryReviewPlanForActiveFix(run: Run): RecoveryReviewPlan | undefined {
  const contexts = run.agentContexts ?? [];
  if (
    !contexts.some(
      (context) =>
        context.role === 'review-fix' &&
        ['launching', 'working', 'waiting'].includes(context.status),
    )
  )
    return undefined;
  const latest = [...(run.engineState?.publishGate?.reviews ?? [])]
    .reverse()
    .find((review) => review.verdict === 'pass' || review.verdict === 'issues');
  // A retained fix context can outlive its completed review loop. It does not
  // authorize replacing the operator's remaining reviewers after a PASS.
  if (latest?.verdict === 'pass') return undefined;
  const reviewer = contexts
    .filter((context) => context.role === 'review' && context.runner)
    .sort((a, b) =>
      (b.attemptStartedAt ?? b.updatedAt ?? '').localeCompare(
        a.attemptStartedAt ?? a.updatedAt ?? '',
      ),
    )[0];
  if (!reviewer?.runner) return undefined;
  const prior = [...(run.engineState?.publishGate?.reviews ?? [])]
    .reverse()
    .find(
      (review) => reviewer.runnerSessionId && review.reviewerSessionId === reviewer.runnerSessionId,
    );
  const selection: ReviewSelection = {
    runner: normalizeRunner(reviewer.runner),
    model: reviewer.model ?? prior?.model ?? null,
    effort: reviewerContextEffort(reviewer) ?? prior?.effort ?? null,
    mode: 'warm',
  };
  const identity = reviewPRIdentity(run);
  const context: ReviewRequestContext | undefined =
    identity && prior ? { reviewLineages: [{ ...identity, reviewId: prior.id }] } : undefined;
  try {
    if (!context)
      throw new WarmReviewRefusal('missing-session', 'no verified reviewId lineage context');
    assertWarmReviewRequestAvailable(run, { ...selection, context }, [run]);
    return { sequence: [selection], context };
  } catch (error) {
    if (!(error instanceof WarmReviewRefusal)) throw error;
    return {
      sequence: [{ ...selection, mode: 'cold' }],
      note: `WARM recovery unavailable: ${error.message}. Using COLD review on the same run; prior reviews remain retained.`,
    };
  }
}

/** Request refusal happens before a parked run is restored or a gate receipt consumed. */
export function assertWarmReviewRequestAvailable(
  run: Run,
  request: unknown,
  runs: readonly Run[],
): void {
  const sequence = reviewSequenceFromRequest(request);
  const context = reviewContextFromRequest(request);
  const identity = reviewPRIdentity(run);
  assertWarmReviewContext(sequence, context);
  for (const [index, row] of sequence.entries()) {
    if (row.mode !== 'warm') continue;
    const lineage = context?.reviewLineages[index];
    if (!lineage)
      throw new WarmReviewRefusal(
        'missing-session',
        'the requested row has no reviewId lineage context',
      );
    if (
      !identity ||
      lineage.repository.toLowerCase() !== identity.repository.toLowerCase() ||
      lineage.prNumber !== identity.prNumber
    )
      throw new WarmReviewRefusal(
        'pr-mismatch',
        'the requested lineage belongs to a different repository/PR',
      );
    const nativeOwners = new Set(
      runs
        .filter((candidate) => {
          const source = reviewPRIdentity(candidate);
          return (
            candidate.project === run.project &&
            source?.repository.toLowerCase() === identity.repository.toLowerCase() &&
            source.prNumber === identity.prNumber
          );
        })
        .flatMap(
          (candidate) =>
            candidate.agentContexts?.flatMap((context) =>
              context.role === 'review' &&
              context.reviewId === lineage.reviewId &&
              context.nativeSession
                ? [context.nativeSession.ownerPrincipalId]
                : [],
            ) ?? [],
        ),
    );
    if (nativeOwners.size > 1)
      throw new WarmReviewRefusal(
        'session-unavailable',
        'the reviewer lineage has ambiguous native ownership',
      );
    const nativeOwner = [...nativeOwners][0];
    const transport = nativeOwner ? 'native' : (run.transport ?? 'tmux');
    if (transport !== 'native' && !runnerSupportsSessionReload(row.runner))
      throw new WarmReviewRefusal(
        'unsupported-runner',
        'the selected runner cannot reload a reviewer',
      );
    const execution = executionModelFromSelection(row);
    const retained = resolveWarmReviewerSession(
      {
        runId: run.id,
        reviewId: lineage.reviewId,
        project: run.project,
        ownerPrincipalId:
          nativeOwner ?? run.nativeOwnerPrincipalId ?? run.createdByPrincipalId ?? null,
        ...(transport === 'tmux'
          ? { ownerPrincipalGeneration: run.createdByPrincipalGeneration }
          : {}),
        transport,
        taskDir: run.taskFile ? path.dirname(run.taskFile) : '',
        artifactScope: lineage.reviewId,
        runner: execution.runner,
        model: execution.model,
        effort: execution.effort,
        repository: identity.repository,
        prNumber: identity.prNumber,
      },
      runs,
    );
    if (!retained)
      throw new WarmReviewRefusal(
        'missing-session',
        'the reviewId has no verified retained session and reviewed head',
      );
  }
}

export function assertPrimaryReviewContext(
  input: Pick<Run, 'flowType' | 'ticketOrPr' | 'reviewMode' | 'reviewContext' | 'prWork'>,
): void {
  const mode = resolveReviewMode({ run: input });
  if (mode !== 'warm') return;
  const raw = input.reviewContext ?? input.prWork?.review?.options.reviewContext;
  if (!raw)
    throw new WarmReviewRefusal(
      'missing-session',
      'WARM requires explicit reviewId lineage context',
    );
  const context = parseReviewRequestContext(raw);
  const bindings = context.reviewLineages.filter(
    (binding): binding is NonNullable<typeof binding> => !!binding,
  );
  if (!bindings.length || new Set(bindings.map((binding) => binding.reviewId)).size !== 1)
    throw new WarmReviewRefusal(
      'missing-session',
      'the requested primary review lineage is missing or ambiguous',
    );
  if (input.flowType !== 'review-pr') return;
  const pr = input.prWork?.pr ?? parseGitHubRef(input.ticketOrPr);
  if (
    !pr ||
    bindings.some(
      (binding) =>
        binding.repository.toLowerCase() !== pr.repo.toLowerCase() ||
        binding.prNumber !== pr.number,
    )
  )
    throw new WarmReviewRefusal(
      'pr-mismatch',
      'the requested review lineage belongs to a different repository/PR',
    );
}
