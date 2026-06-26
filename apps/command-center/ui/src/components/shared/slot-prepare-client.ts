import type { SlotPrepareParams, SlotPrepareResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

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
    return await gateway.request<SlotPrepareResult>(
      Methods.SLOT_PREPARE,
      { ...input, requestId },
      SLOT_PREPARE_TIMEOUT_MS,
    );
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