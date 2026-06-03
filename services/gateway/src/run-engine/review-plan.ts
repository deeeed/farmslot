import {
  isReviewValidationDepth,
  type ReviewDepthPolicy,
  type ReviewLoopRequest,
  reviewValidationDepthForLoop,
  type RunDecision,
} from '@farmslot/protocol';

import { normalizeRunner } from '../runners/registry.js';

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
export const MAX_PUBLISH_GATE_REVIEW_LOOPS = 5;
