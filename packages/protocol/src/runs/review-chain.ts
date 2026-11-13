import type {
  RepeatReviewContext,
  ReviewChainEntry,
  ReviewGatePayload,
  ReviewMode,
  Run,
  RunReviewResult,
} from '../contracts/index.js';
import { isTerminalRunStatus } from '../contracts/runs.js';

import type { RunListRow } from './list-row.js';

interface FreshReviewChainSelection {
  freshChain?: unknown;
  reviewLineages: readonly unknown[];
  mode?: unknown;
  workflow?: unknown;
}

/** Shared validation for an explicit independent review-pr request. */
export function assertFreshReviewChainSelection(selection: FreshReviewChainSelection): void {
  if (selection.freshChain !== undefined && typeof selection.freshChain !== 'boolean')
    throw new Error('freshChain must be boolean');
  if (!selection.freshChain) return;
  if (selection.mode === 'warm' || selection.reviewLineages.some(Boolean))
    throw new Error('A fresh review chain requires COLD without a retained lineage');
  if (selection.workflow === 'qa')
    throw new Error('A fresh review chain applies only to static review-pr requests');
}

export function reviewResultForRun(
  run: Pick<Run, 'reviewResult'> & { decisions: ReadonlyArray<{ payload?: unknown }> },
): RunReviewResult | null {
  if (run.reviewResult) return run.reviewResult;
  for (let index = run.decisions.length - 1; index >= 0; index -= 1) {
    const payload = run.decisions[index]?.payload as ReviewGatePayload | undefined;
    if (payload?.kind === 'review') return payload;
  }
  return null;
}

/**
 * Whether a run has a saved review to show: no open posting gate, and a review result (or a
 * finished review-pr run). It tests presence only, so a run.list row answers as its run does.
 */
export function savedReviewExpected(
  run: Pick<RunListRow, 'flowType' | 'status' | 'reviewResult'> & {
    decisions: ReadonlyArray<{ type: string; resolvedAt?: string | null; payload?: unknown }>;
  },
): boolean {
  const latestGate = [...run.decisions]
    .reverse()
    .find((item) => item.type === 'engine_review_posting');
  if (latestGate && !latestGate.resolvedAt) return false;
  const hasResult =
    run.reviewResult !== undefined ||
    run.decisions.some(
      (decision) =>
        typeof decision.payload === 'object' &&
        decision.payload !== null &&
        Reflect.get(decision.payload, 'kind') === 'review',
    );
  return hasResult || (run.flowType === 'review-pr' && isTerminalRunStatus(run.status));
}

/** Saved choices are requests; only a published receipt confirms the provider event. */
export function savedReviewView(
  run: Pick<Run, 'flowType' | 'status' | 'reviewResult' | 'reviewPublication'> & {
    decisions: ReadonlyArray<{
      type: string;
      resolvedAt?: string | null;
      selectionData?: Record<string, unknown> | null;
      payload?: unknown;
    }>;
  },
) {
  if (!savedReviewExpected(run)) return null;
  const latestGate = [...run.decisions]
    .reverse()
    .find((item) => item.type === 'engine_review_posting');
  const result = reviewResultForRun(run);
  const selection = latestGate?.selectionData;
  const receipt = run.reviewPublication?.receipt;
  return {
    verdict: result?.recommendation?.trim() ? result.recommendation : null,
    reviewedSha: result?.reviewSnapshot?.headSha || null,
    report: result?.reviewMd?.trim() ? result.reviewMd : null,
    requestedRecommendation:
      typeof selection?.recommendation === 'string' ? selection.recommendation : null,
    requestedFindingCount: Array.isArray(selection?.includedIndices)
      ? selection.includedIndices.length
      : null,
    confirmedEvent: receipt?.state === 'published' ? receipt.event : null,
  };
}

export function currentReviewChainEntry(
  run: Pick<
    Run,
    | 'id'
    | 'familyId'
    | 'createdAt'
    | 'completedAt'
    | 'decisions'
    | 'reviewResult'
    | 'metrics'
    | 'repeatReviewContext'
  >,
): ReviewChainEntry | null {
  const context = run.repeatReviewContext;
  if (!context) return null;
  const payload = reviewResultForRun(run);
  return {
    chainId: context.chainId,
    generation: context.generation,
    runId: run.id,
    familyId: run.familyId,
    repository: context.repository,
    prNumber: context.prNumber,
    ...(payload?.reviewSnapshot?.baseSha
      ? { baseSha: payload.reviewSnapshot.baseSha }
      : context.mode === 'warm' && context.priorReviewedHeadSha
        ? { baseSha: context.priorReviewedHeadSha }
        : {}),
    headSha: payload?.reviewSnapshot?.headSha ?? context.currentHeadSha,
    mode: context.mode,
    validationDepth: context.validationDepth,
    verdict: payload?.recommendation?.trim() || 'pending',
    // A run.list row can leave lineComments out (`payloadTrimmed`): unknown, not zero.
    unresolvedCount: payload?.lineComments ? payload.lineComments.length : null,
    artifactRefs: payload?.artifactManifest ?? [],
    runner: run.metrics.runner ?? null,
    model: run.metrics.actualModel ?? run.metrics.model ?? null,
    ...(context.session ? { session: context.session } : {}),
    durationMs: run.metrics.durationMs ?? null,
    ...context.currentMetrics,
    createdAt: run.createdAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
  };
}

/** Shared client projection: immutable predecessors plus the current generation. */
export function reviewChainForRun(
  run: Parameters<typeof currentReviewChainEntry>[0],
): ReviewChainEntry[] {
  const current = currentReviewChainEntry(run);
  if (!current) return [];
  return [...(run.repeatReviewContext?.priorGenerations ?? []), current].sort(
    (left, right) => left.generation - right.generation || left.runId.localeCompare(right.runId),
  );
}

export function reviewModeForContext(
  context: Pick<RepeatReviewContext, 'mode'> | null | undefined,
): ReviewMode {
  return context?.mode ?? 'cold';
}

/** Never turn missing launch evidence into an affirmative continuity claim. */
export function observedReviewSessionContinuity(
  entry: Pick<ReviewChainEntry, 'session'>,
): NonNullable<ReviewChainEntry['session']>['continuity'] | 'unknown' {
  return entry.session?.continuity ?? 'unknown';
}
