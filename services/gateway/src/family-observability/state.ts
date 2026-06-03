import type { Run } from '@farmslot/protocol';

export interface FamilyStateSummary {
  familyId: string;
  familyRootTicketOrPr: string;
  familyRunCount: number;
  activeRunCount: number;
  latestRunId: string;
  latestPrNumber: number | null;
  workflowState: 'active' | 'complete' | 'failed';
  ownedPrFamily: boolean;
}

function familyKey(run: Pick<Run, 'id' | 'familyId'>): string {
  return run.familyId || run.id;
}

export function isActiveFamilyRun(run: Pick<Run, 'status'>): boolean {
  return !['done', 'failed', 'cancelled'].includes(run.status);
}

export function sortRunsByFreshness(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export function buildLatestRunByPrNumber(runs: Run[]): Map<number, Run> {
  const latestByPr = new Map<number, Run>();
  for (const run of sortRunsByFreshness(runs)) {
    if (run.prNumber == null || latestByPr.has(run.prNumber)) continue;
    latestByPr.set(run.prNumber, run);
  }
  return latestByPr;
}

export function buildFamilyStateSummary(familyRuns: Run[]): FamilyStateSummary | null {
  if (familyRuns.length === 0) return null;
  const orderedRuns = sortRunsByFreshness(familyRuns);
  const latestRun = orderedRuns[0];
  // "Owned" PR families are those rooted in Farmslot-created work or explicit follow-ups.
  // Standalone review-pr runs against an external PR should remain outside the owned-family
  // merge projection until they have real lineage or a root bug/dev family behind them.
  const ownedPrFamily =
    orderedRuns.some((run) => run.parentRunId) ||
    orderedRuns.some((run) => run.flowType === 'fix-bug' || run.flowType === 'dev') ||
    (latestRun.prNumber != null &&
      (latestRun.familyRootTicketOrPr ?? latestRun.ticketOrPr) !== latestRun.ticketOrPr);
  return {
    familyId: familyKey(latestRun),
    familyRootTicketOrPr: latestRun.familyRootTicketOrPr ?? latestRun.ticketOrPr,
    familyRunCount: orderedRuns.length,
    activeRunCount: orderedRuns.filter(isActiveFamilyRun).length,
    latestRunId: latestRun.id,
    latestPrNumber: latestRun.prNumber ?? null,
    // Any-done wins: a family is considered complete the moment any run
    // reached `done`. A later failed retry does not invalidate earlier
    // success — the merged PR / delivered fix is the outcome that matters.
    workflowState: orderedRuns.some(isActiveFamilyRun)
      ? 'active'
      : orderedRuns.some((run) => run.status === 'done')
        ? 'complete'
        : 'failed',
    ownedPrFamily,
  };
}

export function findFamilyStateSummaryForPR(
  runs: Run[],
  params: { prNumber: number; project?: string | null },
): FamilyStateSummary | null {
  const candidateRuns = runs.filter(
    (run) =>
      run.prNumber === params.prNumber && (!params.project || run.project === params.project),
  );
  if (candidateRuns.length === 0) return null;
  const latestRun = sortRunsByFreshness(candidateRuns)[0];
  const familyRuns = runs.filter((run) => familyKey(run) === familyKey(latestRun));
  return buildFamilyStateSummary(familyRuns);
}

const ROOT_FLOW_TYPES = new Set<Run['flowType']>(['fix-bug', 'dev']);

/**
 * Find the best parent run for a follow-up flow (review-pr / pr-complete /
 * merge-main) when the caller didn't specify `parentRunId` explicitly.
 *
 * Used by runCreate to auto-link a freshly dispatched pr-complete back to the
 * original fix-bug/dev run on the same PR/ticket so materializeInheritedContext
 * can copy artifacts (recipe.json in particular). Without this, every
 * UI-dispatched pr-complete starts a new family with no recipe inheritance.
 *
 * Strategy: prefer the most recent root-flow run (fix-bug/dev) that produced a
 * taskFile and shares either ticketOrPr or prNumber with the new follow-up.
 * Falls back to ANY run with matching ticket/PR + taskFile if no root match.
 * Returns null if no candidate exists — caller proceeds with no parent (the
 * pre-F6 behavior) so we never break standalone follow-up dispatches.
 */
export function findFollowUpParentRun(
  runs: Run[],
  params: { ticketOrPr: string; prNumber?: number | null; project?: string | null },
): Run | null {
  const matchesTarget = (run: Run): boolean => {
    if (params.project && run.project !== params.project) return false;
    if (run.ticketOrPr === params.ticketOrPr) return true;
    if (params.prNumber != null && run.prNumber === params.prNumber) return true;
    return false;
  };
  const candidates = runs.filter((run) => matchesTarget(run) && Boolean(run.taskFile));
  if (candidates.length === 0) return null;
  const sorted = sortRunsByFreshness(candidates);
  const rootMatch = sorted.find((run) => ROOT_FLOW_TYPES.has(run.flowType));
  return rootMatch ?? sorted[0];
}
