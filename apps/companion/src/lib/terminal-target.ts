import type { Run } from '@farmslot/protocol';

export interface CompanionTerminalTargetParams {
  slotId: string;
  runId?: string;
  bareSession?: true;
}

const READ_ONLY_RUN_STATUSES: ReadonlySet<Run['status']> = new Set(['done', 'failed', 'cancelled']);

export function shouldUseBareTerminalSessionForRun({
  requestedRunId,
  requestedSlotId,
  run,
}: {
  requestedRunId: string | null | undefined;
  requestedSlotId: string;
  run: Pick<Run, 'slotId' | 'status'> | null;
}): boolean {
  if (!requestedRunId) return false;
  if (!run) return true;
  if (!run.slotId) return true;
  if (run.slotId !== requestedSlotId) return true;
  return READ_ONLY_RUN_STATUSES.has(run.status);
}

export function buildCompanionTerminalTarget({
  bareSession,
  runId,
  slotId,
}: {
  slotId: string;
  runId?: string | null;
  bareSession: boolean;
}): CompanionTerminalTargetParams {
  if (bareSession) return { slotId, bareSession: true };
  return { slotId, ...(runId ? { runId } : {}) };
}

export function matchesCompanionTerminalTarget(
  payload: { slotId?: string; runId?: string },
  target: CompanionTerminalTargetParams,
): boolean {
  if (payload.slotId !== target.slotId) return false;
  return target.bareSession === true || !target.runId || payload.runId === target.runId;
}
