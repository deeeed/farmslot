import { isTerminalRunStatus, type Run, type SlotAgentTargetParams } from '@farmslot/protocol';
import { runTerminalTargetMatches, runTerminalTargetParams } from '@farmslot/review-dispatch';

export interface CompanionTerminalTargetParams extends Pick<
  SlotAgentTargetParams,
  'slotId' | 'runId' | 'role' | 'contextId'
> {
  bareSession?: true;
}

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

export function buildCompanionTerminalTarget({
  bareSession,
  runId,
  slotId,
  contextId,
  role,
}: {
  slotId: string;
  runId?: string | null;
  bareSession: boolean;
  contextId?: string;
  role?: SlotAgentTargetParams['role'];
}): CompanionTerminalTargetParams {
  if (bareSession && slotId && !contextId && !role) return { slotId, bareSession: true };
  return runTerminalTargetParams({ slotId, runId: runId ?? undefined, contextId, role });
}

export function matchesCompanionTerminalTarget(
  payload: Partial<Pick<SlotAgentTargetParams, 'slotId' | 'runId' | 'role' | 'contextId'>>,
  target: CompanionTerminalTargetParams,
): boolean {
  if (target.bareSession) return payload.slotId === target.slotId;
  return runTerminalTargetMatches(target, payload);
}
