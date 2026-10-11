import path from 'node:path';

import {
  type AgentContext,
  parseGitHubRef,
  type ReviewPolicy,
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
  reviewContextFromRequest,
  reviewSequenceFromRequest,
} from '@farmslot/review-dispatch';

import {
  effectiveRequiredReviewCount,
  isQualifyingReview,
  qualifyingPassingReviews,
} from '../quality/review-policy.js';
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
  const selection = parseReviewSelection({ ...defaults, mode: 'cold' });
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

export function recoveryReviewPlanForActiveFix(
  run: Pick<Run, 'agentContexts' | 'engineState'>,
): ReviewSequence {
  const contexts = run.agentContexts ?? [];
  if (
    !contexts.some(
      (context) =>
        context.role === 'review-fix' &&
        ['launching', 'working', 'waiting'].includes(context.status),
    )
  )
    return [];
  const reviewer = contexts
    .filter((context) => context.role === 'review' && context.runner)
    .sort((a, b) =>
      (b.attemptStartedAt ?? b.updatedAt ?? '').localeCompare(
        a.attemptStartedAt ?? a.updatedAt ?? '',
      ),
    )[0];
  if (!reviewer?.runner) return [];
  const prior = [...(run.engineState?.publishGate?.reviews ?? [])]
    .reverse()
    .find((review) => review.reviewerSessionId === reviewer.runnerSessionId);
  return [
    {
      runner: normalizeRunner(reviewer.runner),
      model: reviewer.model ?? prior?.model ?? null,
      effort: reviewerContextEffort(reviewer) ?? prior?.effort ?? null,
      mode: 'warm',
    },
  ];
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
    if (run.transport !== 'native' && !runnerSupportsSessionReload(row.runner))
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
        ownerPrincipalId: run.nativeOwnerPrincipalId ?? run.createdByPrincipalId ?? null,
        transport: run.transport ?? 'tmux',
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
  const mode = input.reviewMode ?? input.prWork?.review?.options.mode ?? 'cold';
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
