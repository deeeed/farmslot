import type { MachinePauseReviewedTarget, MachinePauseSelector } from '@farmslot/protocol';

type ReviewedRun = {
  runId: string;
  generation: number;
  selected: boolean;
  eligibility: { eligible: boolean };
};

export function reviewedPauseTargets(
  preview: { runs: readonly ReviewedRun[] } | undefined,
): MachinePauseReviewedTarget[] {
  return reviewedTargets(preview?.runs ?? []);
}

export function reviewedRestoreTargets(
  preview: { runs: readonly ReviewedRun[] } | undefined,
): MachinePauseReviewedTarget[] {
  return reviewedTargets(preview?.runs ?? []);
}

function reviewedTargets(runs: readonly ReviewedRun[]): MachinePauseReviewedTarget[] {
  return runs
    .filter((run) => run.selected && run.eligibility.eligible)
    .map(({ runId, generation }) => ({ runId, generation }));
}

export function eligibleRunIds(runs: readonly ReviewedRun[]): Set<string> {
  return new Set(runs.filter((run) => run.eligibility.eligible).map((run) => run.runId));
}

export function selectedRejectedRunCount(runs: readonly ReviewedRun[]): number {
  return runs.filter((run) => run.selected && !run.eligibility.eligible).length;
}

export function selectorForRunToggle(
  runs: readonly ReviewedRun[],
  runId: string,
  selected: boolean,
): MachinePauseSelector {
  const next = new Set(
    runs.filter((run) => run.selected && run.eligibility.eligible).map((run) => run.runId),
  );
  if (selected) next.add(runId);
  else next.delete(runId);
  return { kind: 'include', runIds: [...next] };
}

export function selectorForAllEligible(runs: readonly ReviewedRun[]): MachinePauseSelector {
  return { kind: 'include', runIds: [...eligibleRunIds(runs)] };
}

export const EMPTY_MACHINE_PAUSE_SELECTOR: MachinePauseSelector = { kind: 'include', runIds: [] };

export function machinePauseMutationDisabled(input: {
  reviewedTargetCount: number;
  selectedRejectedCount: number;
  confirmed: boolean;
  busy: boolean;
  connectionStale: boolean;
}): boolean {
  return (
    input.reviewedTargetCount === 0 ||
    input.selectedRejectedCount > 0 ||
    !input.confirmed ||
    input.busy ||
    input.connectionStale
  );
}

export function machineParkRecordSummary(record: {
  phase: string;
  errors: readonly unknown[];
  residuals: {
    runner: 'running' | 'stopped' | 'unknown';
    resources: ReadonlyArray<{ state: 'running' | 'stopped' | 'unknown' }>;
  };
}): string {
  const residualResources = record.residuals.resources.filter(
    (resource) => resource.state !== 'stopped',
  ).length;
  const parts: string[] = [record.phase];
  if (record.errors.length > 0) parts.push(`${record.errors.length} action error(s)`);
  if (record.residuals.runner !== 'stopped') {
    parts.push(`runner ${record.residuals.runner}`);
  }
  if (residualResources > 0) parts.push(`${residualResources} residual resource(s)`);
  return parts.join(' · ');
}

export function machinePressurePercent(ratio: number | undefined): string {
  return ratio == null ? '–' : `${Math.round(ratio * 100)}%`;
}
