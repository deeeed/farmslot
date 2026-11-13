import {
  type SlotRefreshParams,
  type SlotRefreshResult,
  type SlotStatus,
  slotWorkspaceIdentity,
} from '@farmslot/protocol';

import { loadSlotVars } from '../../core/index.js';
import { loadFleetStatus } from '../../fleet/state.js';

import { recoverSlotWorkspace } from './recover-workspace.js';
import { type EventEmitter, RECOVER_HINT } from './shared.js';
import { inspectSlotWorkspace } from './workspace.js';

export function slotRefreshBlockedReason(slot: SlotStatus | undefined): string | null {
  if (!slot) return null;
  if (slot.workspace?.recovery)
    return `Slot ${slot.slot} requires verified recovery. ${RECOVER_HINT}`;
  const lc = slot.lifecycle;
  if (lc !== 'busy' && lc !== 'held' && !slot.currentRunId) return null;
  const runRef = slot.currentRunId ? ` (run ${slot.currentRunId.slice(0, 8)})` : '';
  return `Slot ${slot.slot} is ${lc}${runRef} — refresh would discard worker state`;
}

export async function slotRefresh(
  params: SlotRefreshParams,
  emit: EventEmitter,
  signal?: AbortSignal,
): Promise<SlotRefreshResult> {
  if (params.release) return recoverSlotWorkspace(params, emit, signal);
  const vars = await loadSlotVars(params.slotId);
  if (!vars.slotEnabled) throw new Error(`Slot ${params.slotId} is disabled`);
  const slot = (await loadFleetStatus()).slots.find((slot) => slot.slot === params.slotId);
  const blocked = slotRefreshBlockedReason(slot);
  if (blocked) throw new Error(blocked);
  const workspace = await inspectSlotWorkspace(params.slotId, {
    network: false,
    timeoutMs: 120_000,
  });
  // Ordinary refresh keeps its resource posture and owner policy, through the same
  // releasing fence and capture owner as release/recovery. There is no unguarded reset.
  return recoverSlotWorkspace(
    {
      ...params,
      release: true,
      expectedWorkspace: params.expectedWorkspace ?? slotWorkspaceIdentity(workspace),
    },
    emit,
    signal,
    { resetOnly: true },
  );
}
