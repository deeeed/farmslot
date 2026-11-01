import type { Run } from '@farmslot/protocol';

/**
 * A run's prepared publication package no longer describes its worker's evidence: a human-gate
 * replay's mirror refresh refused that evidence after the package was built. Neither the gate nor
 * inspection reuses the package until one is committed again. In memory for this process; across
 * a restart the gate's own "unavailable" card (`latestGateHadNoPackage`) carries the same signal.
 */
const stale = new Set<string>();

export function markPreparedPackageStale(runId: string): void {
  stale.add(runId);
}

export function clearPreparedPackageStale(runId: string): void {
  stale.delete(runId);
}

/** The newest ready gate decision carries no package: its gate could not build one. */
function latestGateHadNoPackage(run: Pick<Run, 'decisions'>): boolean {
  const latest = run.decisions
    .filter(
      (decision) => decision.type === 'engine_human_gate' && decision.payload?.kind === 'ready',
    )
    .at(-1);
  return latest?.payload?.kind === 'ready' && !latest.payload.prPackage;
}

export function preparedPackageIsStale(run: Pick<Run, 'id' | 'decisions'>): boolean {
  return stale.has(run.id) || latestGateHadNoPackage(run);
}
