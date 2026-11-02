import type { Run } from '@farmslot/protocol';

import { getRun, persistRunNow, updateRun } from '../runs/store.js';

/**
 * A human-gate replay's mirror refresh refused the worker's evidence after the run's package was
 * prepared, so that package no longer describes the evidence. The refusal is recorded against the
 * package itself: neither the gate nor inspection reuses it, across restarts, until another
 * package replaces it.
 */
export async function markPreparedPackageStale(runId: string): Promise<void> {
  const run = getRun(runId);
  const gate = run?.engineState?.publishGate;
  if (!run || !gate?.packageId || gate.refusedEvidencePackageId === gate.packageId) return;
  const marked = updateRun(runId, {
    engineState: {
      ...run.engineState,
      publishGate: { ...gate, refusedEvidencePackageId: gate.packageId },
    },
  });
  await persistRunNow(marked, 'refused-evidence-package');
}

export function preparedPackageIsStale(run: Pick<Run, 'engineState'>): boolean {
  const gate = run.engineState?.publishGate;
  return !!gate?.packageId && gate.refusedEvidencePackageId === gate.packageId;
}
