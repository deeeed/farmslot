import {
  type AgentContext,
  type IndependentReviewStatus,
  isReviewValidationDepth,
  type ReviewDepthPolicy,
  type ReviewLoopRequest,
  type ReviewRunnerId,
  reviewValidationDepthForLoop,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import {
  effectiveRequiredReviewCount,
  isQualifyingIndependentReview,
} from '../quality/review-policy.js';
import { defaultAlternateReviewRunner, normalizeRunner } from '../runners/registry.js';

export function reviewPlanFromSelection(
  selectionData: Record<string, unknown> | undefined,
): ReviewLoopRequest[] {
  const request =
    selectionData?.reviewRequest && typeof selectionData.reviewRequest === 'object'
      ? (selectionData.reviewRequest as Record<string, unknown>)
      : {};
  const rawLoops = (Array.isArray(request.loops) ? request.loops : []).slice(
    0,
    MAX_PUBLISH_GATE_REVIEW_LOOPS,
  );
  const loops = rawLoops.flatMap((raw, index): ReviewLoopRequest[] => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const runner =
      typeof record.runner === 'string' && record.runner.trim() ? record.runner.trim() : 'same';
    const model =
      typeof record.model === 'string' && record.model.trim() ? record.model.trim() : null;
    const validationDepth = isReviewValidationDepth(record.validationDepth)
      ? record.validationDepth
      : reviewValidationDepthForLoop(index, rawLoops.length);
    return [
      { order: index + 1, runner: runner as ReviewLoopRequest['runner'], model, validationDepth },
    ];
  });
  if (loops.length) return loops;
  const requestedLoops = Number(request.extraLoopsRequested);
  const count = Number.isFinite(requestedLoops)
    ? Math.max(1, Math.min(MAX_PUBLISH_GATE_REVIEW_LOOPS, Math.round(requestedLoops)))
    : 1;
  return Array.from({ length: count }, (_, index) => ({
    order: index + 1,
    runner: 'same',
    validationDepth: reviewValidationDepthForLoop(index, count),
  }));
}
export function effectiveReviewRunner(loop: ReviewLoopRequest): string | null {
  return loop.runner && loop.runner !== 'same' ? normalizeRunner(loop.runner) : null;
}

export function requestedReviewLoopCount(
  reviewRequest: Record<string, unknown>,
  fallbackCount = 1,
): number {
  const rawLoops = Array.isArray(reviewRequest.loops) ? reviewRequest.loops : [];
  if (rawLoops.length > 0)
    return Math.max(1, Math.min(MAX_PUBLISH_GATE_REVIEW_LOOPS, rawLoops.length));
  const requestedLoops = Number(reviewRequest.extraLoopsRequested);
  return Number.isFinite(requestedLoops)
    ? Math.max(1, Math.min(MAX_PUBLISH_GATE_REVIEW_LOOPS, Math.round(requestedLoops)))
    : Math.max(1, Math.min(MAX_PUBLISH_GATE_REVIEW_LOOPS, fallbackCount));
}

/**
 * Materialize the configured publication-review minimum into executable work.
 * A pipeline self-review is useful worker feedback, but it is not independent
 * and therefore never consumes this budget. The default publication review is
 * static; operators and explicit dispatch plans can still request full-live.
 */
export function automaticPublicationReviewPlan(
  policy: ReviewDepthPolicy,
  reviews: IndependentReviewStatus[],
  workerRunner?: string | null,
): ReviewLoopRequest[] {
  const passing = reviews.filter(
    (review) =>
      isQualifyingIndependentReview(review) &&
      review.verdict === 'pass' &&
      review.unresolvedCount === 0,
  );
  const crossRunnerAlreadySatisfied =
    !policy.requireCrossRunner || passing.some((review) => review.crossRunner);
  const missing = Math.max(
    Math.max(0, effectiveRequiredReviewCount(policy) - passing.length),
    crossRunnerAlreadySatisfied ? 0 : 1,
  );

  return Array.from({ length: missing }, (_, index) => ({
    order: index + 1,
    runner:
      policy.requireCrossRunner && !crossRunnerAlreadySatisfied && index === 0
        ? (defaultAlternateReviewRunner(workerRunner) as ReviewLoopRequest['runner'])
        : 'same',
    validationDepth: 'static-code',
  }));
}

export function remainingExplicitReviewPlan(
  plan: ReviewLoopRequest[],
  reviews: IndependentReviewStatus[],
  scope: {
    requestedAt?: string;
    source?: IndependentReviewStatus['source'];
  } = {},
): ReviewLoopRequest[] {
  const requestedAt = scope.requestedAt ? Date.parse(scope.requestedAt) : Number.NaN;
  const passingReviews = reviews.filter(
    (review) =>
      isQualifyingIndependentReview(review) &&
      review.verdict === 'pass' &&
      review.unresolvedCount === 0 &&
      (!scope.source || (review.source ?? 'dispatch') === scope.source) &&
      (!Number.isFinite(requestedAt) ||
        Date.parse(review.completedAt ?? review.startedAt ?? '') >= requestedAt),
  );
  let completedPrefix = 0;
  const unusedPassingReviews = [...passingReviews];
  for (const planStep of plan) {
    const matchingIndex = unusedPassingReviews.findIndex(
      (review) =>
        planStep.runner === 'same' ||
        normalizeRunner(review.runner) === normalizeRunner(planStep.runner),
    );
    if (matchingIndex < 0) break;
    unusedPassingReviews.splice(matchingIndex, 1);
    completedPrefix += 1;
  }
  return plan.slice(completedPrefix);
}

export function humanGateReviewDepth(
  basePolicy: ReviewDepthPolicy,
  reviewRequest: Record<string, unknown>,
  options: {
    actionId?: string;
    fallbackLoopCount?: number;
  } = {},
): ReviewDepthPolicy {
  const loopsToRequire = requestedReviewLoopCount(reviewRequest, options.fallbackLoopCount ?? 1);
  const requiresCrossRunner =
    basePolicy.requireCrossRunner ||
    options.actionId === 'request-cross-runner-review' ||
    reviewRequest.requireCrossRunner === true;
  return {
    minimumIndependentReviews: Math.max(
      basePolicy.minimumIndependentReviews,
      requiresCrossRunner ? 1 : 0,
      loopsToRequire,
    ),
    requireCrossRunner: requiresCrossRunner,
    // Human gate review requests are work orders, not permanent additive
    // policy. The requested reviews must pass before the gate re-opens, but a
    // second click must not inflate required reviews forever.
    extraLoopsRequested: 0,
    requestedBy: 'human-gate',
  };
}

export function humanGateReviewRequestFromDecision(
  decision: RunDecision | undefined,
): Record<string, unknown> {
  const selectionData = decision?.selectionData;
  return selectionData?.reviewRequest && typeof selectionData.reviewRequest === 'object'
    ? (selectionData.reviewRequest as Record<string, unknown>)
    : {};
}

const HUMAN_GATE_REVIEW_REQUEST_ACTIONS = new Set([
  'request-extra-review',
  'request-cross-runner-review',
]);

/**
 * Latest resolved human-gate decision whose action was a review request
 * (not an approval). Used when building the executable review plan so a
 * second request-extra-review with a different runner is not ignored in
 * favor of a stale pending plan or an approval-only lookup.
 */
export function latestResolvedHumanGateReviewRequestDecision(
  decisions: readonly RunDecision[],
): RunDecision | undefined {
  return decisions
    .filter(
      (decision) =>
        decision.type === 'engine_human_gate' &&
        !!decision.resolvedAt &&
        HUMAN_GATE_REVIEW_REQUEST_ACTIONS.has(decision.resolvedAction ?? ''),
    )
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))[0];
}

/**
 * Choose the plan the publish-gate loop will execute after a human-gate
 * review request.
 *
 * Live bug (MANUAL-000087 / run 71803bd2): operator requested codex on the
 * second request-extra-review, but the loop preferred a stale pending plan
 * (claude) and/or fell back via approval-only decision lookup, so Claude
 * launched. The latest review-request decision's selectionData is
 * authoritative when it carries explicit loops.
 */
export function resolveHumanGateReviewExecutionPlan(input: {
  gateAction: string;
  pendingPlan: readonly ReviewLoopRequest[];
  decisions: readonly RunDecision[];
}): ReviewLoopRequest[] {
  const { gateAction, pendingPlan, decisions } = input;
  if (!HUMAN_GATE_REVIEW_REQUEST_ACTIONS.has(gateAction)) {
    return pendingPlan.length ? [...pendingPlan] : [];
  }

  const latestRequest = latestResolvedHumanGateReviewRequestDecision(decisions);
  const fromDecision = reviewPlanFromSelection(latestRequest?.selectionData);
  const decisionHasExplicitRunner = fromDecision.some((loop) => effectiveReviewRunner(loop));
  if (decisionHasExplicitRunner) return fromDecision;

  if (pendingPlan.length > 0) return [...pendingPlan];
  return fromDecision;
}

const REVIEW_RUNNERS = new Set<ReviewRunnerId>(['claude', 'codex', 'cursor', 'grok', 'opencode']);

function contextTimestamp(context: AgentContext): number {
  const value =
    context.attemptStartedAt ?? context.completedAt ?? context.updatedAt ?? context.startedAt ?? '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Reconstruct the review work order when a gateway restart interrupted an
 * independent-review fix pass after the gate had already consumed its pending
 * plan. The latest reviewer context identifies the runner/model that must
 * re-enter executeSelfReview, whose fix-pass recovery resumes the live worker.
 */
export function recoveryReviewPlanForActiveFix(
  run: Pick<Run, 'agentContexts' | 'engineState'>,
): ReviewLoopRequest[] {
  const contexts = run.agentContexts ?? [];
  const activeFix = contexts.some(
    (context) =>
      context.role === 'self-review-fix' &&
      (context.status === 'launching' ||
        context.status === 'working' ||
        context.status === 'waiting'),
  );
  if (!activeFix) return [];

  const reviewer = contexts
    .filter((context) => context.role === 'self-review' && context.runner)
    .sort((left, right) => contextTimestamp(right) - contextTimestamp(left))[0];
  if (!reviewer) return [];

  const normalizedRunner = normalizeRunner(reviewer.runner);
  const runner = REVIEW_RUNNERS.has(normalizedRunner as ReviewRunnerId)
    ? (normalizedRunner as ReviewRunnerId)
    : 'same';
  const matchingReview = [...(run.engineState?.publishGate?.independentReviews ?? [])]
    .reverse()
    .find((review) => normalizeRunner(review.runner) === normalizedRunner);
  return [
    {
      order: 1,
      runner,
      model: reviewer.model ?? null,
      validationDepth: matchingReview?.validationDepth ?? 'full-live',
    },
  ];
}

export const MAX_PUBLISH_GATE_REVIEW_LOOPS = 5;
