import type { SlotRecycleParams } from '@farmslot/protocol';

import { slotRelease } from './release.js';
import type { EventEmitter } from './shared.js';

export async function slotRecycle(
  params: SlotRecycleParams,
  emit: EventEmitter,
): Promise<{ released: boolean }> {
  return slotRelease(
    {
      slotId: params.slotId,
      keepWarm: true,
      ...(params.forceReset !== undefined ? { forceReset: params.forceReset } : {}),
      ...(params.requestId ? { requestId: params.requestId } : {}),
    },
    emit,
  );
}

// ─── slotRefresh — fast pre-warm: sync to default branch @ origin/HEAD ───
// Pure git: no preflight, no device, no dev-server, no dep install. The point
// is a sub-10s "make this slot dispatch-ready on latest main" action so a
// queued dispatch picks it up instantly. Streams progress as `script.output`
// + `script.complete` events keyed by `requestId` so the existing UI panel
// (slot-view._actionOutput) renders live without any new event wiring.

// Pure predicate: returns a human-readable rejection reason when refresh
// would clobber active worker state, or null when refresh is safe to run.
// Extracted so the lifecycle guard can be unit-tested without mocking
