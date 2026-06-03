import type { FamilyObservabilityRunSummary, RunDecision } from '@farmslot/protocol';

export interface FamilyRetrospectiveEntry {
  run: FamilyObservabilityRunSummary;
  decision: RunDecision;
}

export function collectFamilyRetrospectives(
  runs: FamilyObservabilityRunSummary[],
): FamilyRetrospectiveEntry[] {
  return runs
    .flatMap((run) =>
      (run.decisions ?? [])
        .filter((decision) => decision.type === 'retrospective')
        .map((decision) => ({ run, decision })),
    )
    .sort(compareFamilyRetrospectives);
}

function compareFamilyRetrospectives(
  left: FamilyRetrospectiveEntry,
  right: FamilyRetrospectiveEntry,
): number {
  const leftResolved = Boolean(left.decision.resolvedAt);
  const rightResolved = Boolean(right.decision.resolvedAt);
  if (leftResolved !== rightResolved) return leftResolved ? 1 : -1;
  return retrospectiveTime(right) - retrospectiveTime(left);
}

function retrospectiveTime(entry: FamilyRetrospectiveEntry): number {
  const timestamp = entry.decision.resolvedAt ?? entry.decision.createdAt ?? entry.run.updatedAt;
  const parsed = new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
