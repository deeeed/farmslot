import type {
  ReviewContinuationContext,
  ReviewRequestContext,
  ReviewSequence,
  ReviewSessionTrace,
  Run,
} from '@farmslot/protocol';

import type { ReviewDispatchSequenceRole } from './types.js';

/** A lineage is keyed by its PR once there is one, else by its run family, plus `reviewId`. */
export function reviewLineageKey(context: ReviewContinuationContext): string {
  return context.repository
    ? `${context.repository.toLowerCase()}#${context.prNumber}::${context.reviewId}`
    : `${context.familyId}::${context.reviewId}`;
}

/** Only retained session/head evidence can seed WARM context; a PR is recorded once present. */
export function reviewLineagesForRun(
  run:
    | Pick<Run, 'familyId' | 'engineState' | 'decisions' | 'reviewResult' | 'repeatReviewContext'>
    | null
    | undefined,
): ReviewContinuationContext[] {
  if (!run) return [];
  const lineages = new Map<string, ReviewContinuationContext>();
  const add = (trace: ReviewSessionTrace | undefined) => {
    if (
      !trace?.reviewId ||
      !trace.sessionId ||
      !trace.lastReviewedHeadSha ||
      !['fresh', 'resumed'].includes(trace.continuity)
    )
      return;
    // A lineage names its PR once there is one; before that, its run family.
    const context: ReviewContinuationContext = {
      ...(trace.repository && trace.prNumber
        ? { repository: trace.repository, prNumber: trace.prNumber }
        : { familyId: run.familyId }),
      reviewId: trace.reviewId,
    };
    lineages.set(reviewLineageKey(context), context);
  };
  add(run.reviewResult?.session);
  add(run.repeatReviewContext?.session);
  for (const review of run.engineState?.publishGate?.reviews ?? []) add(review.session);
  for (const decision of run.decisions) {
    if (decision.payload?.kind === 'review') add(decision.payload.session);
    if (decision.payload?.kind === 'ready')
      for (const review of decision.payload.reviews ?? []) add(review.session);
  }
  return [...lineages.values()];
}

/** A general recheck may bind only one unambiguous lineage. Specific hosts supply its ID. */
export function reviewRequestContextForRun(
  run: Parameters<typeof reviewLineagesForRun>[0],
  reviewId?: string,
): ReviewRequestContext | undefined {
  const lineages = reviewLineagesForRun(run).filter(
    (context) => reviewId === undefined || context.reviewId === reviewId,
  );
  return lineages.length === 1 ? { reviewLineages: [lineages[0]] } : undefined;
}

export function assertWarmReviewContext(
  sequence: ReviewSequence,
  context?: ReviewRequestContext,
  sequenceRole: ReviewDispatchSequenceRole = 'reviews',
): void {
  const used = new Set<string>();
  sequence.forEach((selection, index) => {
    if (selection.mode !== 'warm') return;
    const lineage = context?.reviewLineages[index];
    if (!lineage)
      throw new Error(
        `WARM review row ${index + 1} requires an unambiguous run family or repository/PR and reviewId lineage. Choose COLD or open a specific review recheck.`,
      );
    const key = reviewLineageKey(lineage);
    if (sequenceRole === 'reviews' && used.has(key))
      throw new Error('A WARM sequence cannot count the same review lineage twice');
    used.add(key);
  });
}

export function reviewLineagesForPR(
  runs: readonly Parameters<typeof reviewLineagesForRun>[0][],
  pr: import('@farmslot/protocol').MonitoredPRIdentity,
): ReviewContinuationContext[] {
  const repository = pr.repo.toLowerCase();
  const qualified = `${pr.host.toLowerCase()}/${repository}`;
  const lineages = new Map<string, ReviewContinuationContext>();
  for (const run of runs)
    for (const context of reviewLineagesForRun(run)) {
      const capturedRepository = context.repository?.toLowerCase();
      if (
        !capturedRepository ||
        context.prNumber !== pr.number ||
        (capturedRepository !== qualified &&
          !(pr.host.toLowerCase() === 'github.com' && capturedRepository === repository))
      )
        continue;
      lineages.set(reviewLineageKey(context), context);
    }
  return [...lineages.values()];
}

export function reviewRequestContextForPR(
  runs: Parameters<typeof reviewLineagesForPR>[0],
  pr: Parameters<typeof reviewLineagesForPR>[1],
  reviewId?: string,
): ReviewRequestContext | undefined {
  const lineages = reviewLineagesForPR(runs, pr).filter(
    (context) => reviewId === undefined || context.reviewId === reviewId,
  );
  return lineages.length === 1 ? { reviewLineages: [lineages[0]] } : undefined;
}
