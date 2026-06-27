// methods/slot/prepare-status.ts — snapshot of an in-flight prepare so a
// reloaded UI can re-attach to the live stream and recover missed steps (ADR-037).

import type { SlotPrepareStatusParams, SlotPrepareStatusResult } from '@farmslot/protocol';

import { activePrepareSessions } from './shared.js';

export function slotPrepareStatus(params: SlotPrepareStatusParams): SlotPrepareStatusResult {
  const session = activePrepareSessions.get(params.slotId);
  if (!session) return { preparing: false, steps: [] };
  return { preparing: true, requestId: session.requestId, steps: [...session.steps] };
}
