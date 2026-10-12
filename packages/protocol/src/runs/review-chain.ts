import type {
  RepeatReviewContext,
  ReviewChainEntry,
  ReviewGatePayload,
  ReviewMode,
  Run,
  RunReviewResult,
} from '../contracts/index.js';
import { isTerminalRunStatus } from '../contracts/runs.js';

export function reviewResultForRun(
  run: Pick<Run, 'decisions' | 'reviewResult'>,
): RunReviewResult | null {
  if (run.reviewResult) return run.reviewResult;
  for (let index = run.decisions.length - 1; index >= 0; index -= 1) {
    const payload = run.decisions[index]?.payload as ReviewGatePayload | undefined;
    if (payload?.kind === 'review') return payload;
  }
  return null;
}

/** Saved choices are requests; only a published receipt confirms the provider event. */
export function savedReviewView(
  run: Pick<Run, 'flowType' | 'status' | 'decisions' | 'reviewResult' | 'reviewPublication'>,
) {
  const latestGate = [...run.decisions]
    .reverse()
    .find((item) => item.type === 'engine_review_posting');
  if (latestGate && !latestGate.resolvedAt) return null;
  const result = reviewResultForRun(run);
  if (!result && (run.flowType !== 'review-pr' || !isTerminalRunStatus(run.status))) return null;
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
    unresolvedCount: payload ? payload.lineComments.length : null,
    artifactRefs: payload?.artifactManifest ?? [],
    runner: run.metrics.runner ?? null,
    model: run.metrics.actualModel ?? run.metrics.model ?? null,
    ...(context.session ? { session: context.session } : {}),
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
