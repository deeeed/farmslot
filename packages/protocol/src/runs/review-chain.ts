import type {
  RepeatReviewContext,
  ReviewChainEntry,
  ReviewGatePayload,
  ReviewSessionIntent,
  Run,
} from '../contracts/index.js';

function latestReviewPayload(run: Pick<Run, 'decisions'>): ReviewGatePayload | null {
  for (let index = run.decisions.length - 1; index >= 0; index -= 1) {
    const payload = run.decisions[index]?.payload as ReviewGatePayload | undefined;
    if (payload?.kind === 'review') return payload;
  }
  return null;
}

export function currentReviewChainEntry(
  run: Pick<
    Run,
    | 'id'
    | 'familyId'
    | 'createdAt'
    | 'completedAt'
    | 'decisions'
    | 'metrics'
    | 'repeatReviewContext'
  >,
): ReviewChainEntry | null {
  const context = run.repeatReviewContext;
  if (!context) return null;
  const payload = latestReviewPayload(run);
  return {
    chainId: context.chainId,
    generation: context.generation,
    runId: run.id,
    familyId: run.familyId,
    repository: context.repository,
    prNumber: context.prNumber,
    ...(payload?.reviewSnapshot?.baseSha
      ? { baseSha: payload.reviewSnapshot.baseSha }
      : context.reviewScope === 'incremental' && context.priorReviewedHeadSha
        ? { baseSha: context.priorReviewedHeadSha }
        : {}),
    headSha: payload?.reviewSnapshot?.headSha ?? context.currentHeadSha,
    reviewScope: context.reviewScope,
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

export function reviewSessionIntentForContext(
  context: Pick<RepeatReviewContext, 'sessionIntent'> | null | undefined,
): ReviewSessionIntent {
  return context?.sessionIntent ?? 'reset';
}

/** Never turn missing launch evidence into an affirmative continuity claim. */
export function observedReviewSessionContinuity(
  entry: Pick<ReviewChainEntry, 'session'>,
): NonNullable<ReviewChainEntry['session']>['continuity'] | 'unknown' {
  return entry.session?.continuity ?? 'unknown';
}
