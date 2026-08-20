import type {
  MachineParkPhase,
  MachinePauseMode,
  MachinePauseRestoreParams,
  MachinePauseReviewedTarget,
  MachinePauseSelector,
} from '@farmslot/protocol';

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

export function restoreExecuteParams(
  machine: string,
  preview: {
    previewId: string;
    selector: MachinePauseSelector;
    runs: readonly ReviewedRun[];
  },
): Extract<MachinePauseRestoreParams, { execute: true }> {
  return {
    machine,
    selector: preview.selector,
    execute: true,
    previewId: preview.previewId,
    reviewedTargets: reviewedRestoreTargets(preview),
  };
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
  mode: MachinePauseMode;
  phase: string;
  errors: readonly unknown[];
  residuals: {
    runner: 'running' | 'stopped' | 'unknown';
    resources: ReadonlyArray<{
      resourceId: string;
      state: 'running' | 'stopped' | 'unknown';
    }>;
  };
}): string {
  const residuals = machineParkResidualAssessment(record);
  const parts: string[] = [record.phase];
  if (record.errors.length > 0) parts.push(`${record.errors.length} action error(s)`);
  if (residuals.runner.warning) {
    parts.push(`runner ${residuals.runner.actual} unexpected`);
  }
  const unexpectedResources = residuals.resources.filter((resource) => resource.warning).length;
  if (unexpectedResources > 0) parts.push(`${unexpectedResources} unexpected resource(s)`);
  return parts.join(' · ');
}

type ResidualState = 'running' | 'stopped' | 'unknown';

export interface MachineParkResidualAssessment {
  runner: { actual: ResidualState; expected?: ResidualState; warning: boolean };
  resources: Array<{
    resourceId: string;
    actual: ResidualState;
    expected?: ResidualState;
    warning: boolean;
  }>;
  hasWarnings: boolean;
}

function expectedResidualState(
  mode: MachinePauseMode,
  phase: MachineParkPhase | string,
): ResidualState | undefined {
  if (phase === 'restored') return 'running';
  if (mode === 'orchestration' && (phase === 'orchestration-paused' || phase === 'parked')) {
    return 'running';
  }
  if (mode === 'release' && phase === 'parked') return 'stopped';
  return undefined;
}

export function machineParkResidualAssessment(record: {
  mode: MachinePauseMode;
  phase: MachineParkPhase | string;
  residuals: {
    runner: ResidualState;
    resources: ReadonlyArray<{ resourceId: string; state: ResidualState }>;
  };
}): MachineParkResidualAssessment {
  const expected = expectedResidualState(record.mode, record.phase);
  const runnerWarning =
    record.residuals.runner === 'unknown' ||
    (expected != null && record.residuals.runner !== expected);
  const resources = record.residuals.resources.map((resource) => ({
    resourceId: resource.resourceId,
    actual: resource.state,
    ...(expected ? { expected } : {}),
    warning: resource.state === 'unknown' || (expected != null && resource.state !== expected),
  }));
  return {
    runner: {
      actual: record.residuals.runner,
      ...(expected ? { expected } : {}),
      warning: runnerWarning,
    },
    resources,
    hasWarnings: runnerWarning || resources.some((resource) => resource.warning),
  };
}

export function sortMachinePauseRecords<T extends { runId: string; updatedAt: string }>(
  records: readonly T[],
): T[] {
  return [...records].sort((left, right) => {
    const byUpdatedAt = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return byUpdatedAt || left.runId.localeCompare(right.runId);
  });
}

export function machinePressurePercent(ratio: number | undefined): string {
  return ratio == null ? '–' : `${Math.round(ratio * 100)}%`;
}
