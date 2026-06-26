import type { SlotPrepareParams, SlotPrepareResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { slotViewHash } from '../slot-view/slot-view-url-state.js';

import { resolveBindOnly } from './slot-prepare-options-model.js';
import {
  beginSlotPrepareSession,
  scheduleSlotPrepareSessionClear,
} from './slot-prepare-tracker.js';

/** Cover metamask-mobile-farm prepare_deps_s (5400s) with headroom. */
export const SLOT_PREPARE_TIMEOUT_MS = 7_200_000;

export interface RunSlotPrepareInput extends SlotPrepareParams {
  label?: string;
}

export async function runSlotPrepare(input: RunSlotPrepareInput): Promise<SlotPrepareResult> {
  const requestId = input.requestId ?? `prepare-${crypto.randomUUID()}`;
  beginSlotPrepareSession({
    slotId: input.slotId,
    requestId,
    label: input.label,
  });
  try {
    const result = await gateway.request<SlotPrepareResult>(
      Methods.SLOT_PREPARE,
      { ...input, requestId },
      SLOT_PREPARE_TIMEOUT_MS,
    );
    if (!result.prepared) {
      throw new Error(`Slot ${input.slotId} prepare did not complete (slot may be disabled)`);
    }
    return result;
  } finally {
    // Keep the session visible briefly after completion for the banner/panel.
    scheduleSlotPrepareSessionClear(input.slotId, 8_000);
  }
}

export function shouldBindOnlyForLoadRun(
  runBranch: string | null | undefined,
  slotBranch: string | null | undefined,
  forcePrepare = false,
): boolean {
  return resolveBindOnly(runBranch, slotBranch, forcePrepare);
}

/** Shared warm-switch + bind path for load-run, popover, and run-detail actions. */
export interface RunSlotPrepareForRunInput {
  slotId: string;
  runId: string;
  branch: string;
  slotBranch?: string | null;
  prepareProfile?: string;
  strictProfile?: boolean;
  forcePrepare?: boolean;
  rebind?: boolean;
  label?: string;
}

export function slotPrepareLabel(slotId: string, runId: string, bindOnly: boolean): string {
  return bindOnly
    ? `Binding run ${runId.slice(0, 8)} on ${slotId}`
    : `Preparing ${slotId} for run ${runId.slice(0, 8)}`;
}

/** Navigate to slot-view with the prepared run pinned in the URL. */
export function navigateToPreparedSlot(slotId: string, runId: string): void {
  window.location.hash = slotViewHash({ slotId, runId });
}

export async function runSlotPrepareForRun(
  input: RunSlotPrepareForRunInput,
): Promise<SlotPrepareResult> {
  const prepareProfile = input.prepareProfile?.trim() || undefined;
  const strictProfile = input.strictProfile !== false;
  const bindOnly = resolveBindOnly(input.branch, input.slotBranch, input.forcePrepare ?? false);
  return runSlotPrepare({
    slotId: input.slotId,
    branch: input.branch,
    ...(prepareProfile ? { prepareProfile } : {}),
    strictProfile,
    bindOnly,
    bindRunId: input.runId,
    runId: input.runId,
    rebind: input.rebind,
    label: input.label ?? slotPrepareLabel(input.slotId, input.runId, bindOnly === true),
  });
}
