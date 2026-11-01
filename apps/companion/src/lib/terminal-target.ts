import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

/** A run page whose run finished or left the slot opens the slot's own session. */
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
  return isTerminalRunStatus(run.status);
}
