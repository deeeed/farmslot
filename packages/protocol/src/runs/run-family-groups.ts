import { isActiveListRun, type Run } from '../contracts/runs.js';
import { compareText } from '../text-order.js';

import { buildFamilySummary } from './family-readiness.js';

export interface RunFamilyGroup {
  familyId: string;
  project: string;
  familyRootTicketOrPr: string;
  rootRun: Run | null;
  representativeRun: Run;
  familySummary: string;
  runs: Run[];
  latestCreatedAt: string;
  activeCount: number;
  comparisonCount: number;
  retrospectiveCount: number;
  pendingRetrospectiveCount: number;
  variants: string[];
}

function isFamilyRoot(run: Run): boolean {
  return run.id === run.familyId || run.parentRunId == null;
}

function sortByCreatedAtDesc(runs: readonly Run[]): Run[] {
  return [...runs].sort((left, right) => compareText(right.createdAt, left.createdAt));
}

export function sortRunsForFamilyView(runs: readonly Run[]): Run[] {
  return [...runs].sort((left, right) => {
    if (isFamilyRoot(left) !== isFamilyRoot(right)) return isFamilyRoot(left) ? -1 : 1;
    if ((left.variant ?? null) !== (right.variant ?? null)) {
      return compareText(left.variant ?? '', right.variant ?? '');
    }
    return compareText(right.createdAt, left.createdAt);
  });
}

/** Runs grouped by project and family, newest family first; Command Center and Companion share it. */
export function groupRunsByFamily(runs: readonly Run[]): RunFamilyGroup[] {
  const grouped = new Map<string, { familyId: string; project: string; runs: Run[] }>();
  for (const run of runs) {
    const familyId = run.familyId || run.id;
    const key = `${run.project}::${familyId}`;
    const current = grouped.get(key);
    if (current) current.runs.push(run);
    else grouped.set(key, { familyId, project: run.project, runs: [run] });
  }

  return [...grouped.values()]
    .map(({ familyId, project, runs: familyRuns }) => {
      const orderedRuns = sortRunsForFamilyView(familyRuns);
      const rootRun = orderedRuns.find(isFamilyRoot) ?? null;
      const newestByCreatedAt = sortByCreatedAtDesc(orderedRuns)[0];
      const representativeRun = rootRun ?? newestByCreatedAt;
      const latestCreatedAt = orderedRuns.reduce(
        (latest, run) => (run.createdAt > latest ? run.createdAt : latest),
        orderedRuns[0]?.createdAt ?? '',
      );
      const variants = [
        ...new Set(
          orderedRuns
            .map((run) => run.variant)
            .filter((variant): variant is string => Boolean(variant)),
        ),
      ];
      const retrospectiveDecisions = orderedRuns.flatMap((run) =>
        (run.decisions ?? []).filter((decision) => decision.type === 'retrospective'),
      );

      return {
        familyId,
        project,
        familyRootTicketOrPr:
          rootRun?.familyRootTicketOrPr ??
          representativeRun?.familyRootTicketOrPr ??
          representativeRun?.ticketOrPr ??
          familyId,
        rootRun,
        representativeRun,
        familySummary: buildFamilySummary(rootRun, newestByCreatedAt, orderedRuns),
        runs: orderedRuns,
        latestCreatedAt,
        activeCount: orderedRuns.filter(isActiveListRun).length,
        comparisonCount: orderedRuns.filter((run) => run.lane === 'comparison').length,
        retrospectiveCount: retrospectiveDecisions.length,
        pendingRetrospectiveCount: retrospectiveDecisions.filter((decision) => !decision.resolvedAt)
          .length,
        variants,
      } satisfies RunFamilyGroup;
    })
    .sort((left, right) => compareText(right.latestCreatedAt, left.latestCreatedAt));
}

export function selectRecentRunFamilyGroups(runs: readonly Run[], limit: number): RunFamilyGroup[] {
  if (limit <= 0) return [];
  return groupRunsByFamily(runs).slice(0, limit);
}
