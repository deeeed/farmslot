import { Events, type FleetStatusResult, isRecord, type SlotWorkspace } from '@farmslot/protocol';

import type { GatewayClient } from '../gateway-client.js';

/** Recovery alone needs a workspace witness; ordinary forced health stays fast. */
export async function forcedRecoveryWorkspace(
  client: Pick<GatewayClient, 'connect'>,
  slotId: string,
  waitMs = 30_000,
): Promise<SlotWorkspace> {
  const connection = await client.connect();
  let initialError: string | undefined;
  let notifications = 0;
  let consumed = 0;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = connection.onEvent((event) => {
    if (event.event !== Events.FLEET_UPDATED || !isRecord(event.payload)) return;
    const fleet = event.payload.fleet;
    if (!isRecord(fleet) || !Array.isArray(fleet.slots)) return;
    const slot = fleet.slots.find((value: unknown) => isRecord(value) && value.slot === slotId);
    if (!isRecord(slot)) return;
    if (
      slot.workspace ||
      (typeof slot.workspaceError === 'string' && slot.workspaceError !== initialError)
    ) {
      notifications++;
      wake?.();
    }
  });
  try {
    const first = await connection.call<FleetStatusResult>('fleet.status', { forceRefresh: true });
    let slot = first.fleet.slots.find((value) => value.slot === slotId);
    if (!slot) throw new Error(`Slot ${slotId} is not in the observed fleet`);
    initialError = slot?.workspaceError;
    const deadline = Date.now() + waitMs;
    while (!slot?.workspace) {
      if (slot?.workspaceError && slot.workspaceError !== initialError)
        throw new Error(slot.workspaceError);
      let timedOut = Date.now() >= deadline;
      if (!timedOut && notifications === consumed) {
        await new Promise<void>((resolve) => {
          wake = () => {
            clearTimeout(timer);
            timer = undefined;
            resolve();
          };
          timer = setTimeout(() => {
            timer = undefined;
            timedOut = true;
            resolve();
          }, deadline - Date.now());
        });
      }
      consumed = notifications;
      // Events are notifications, never destructive authority. Re-read the
      // typed cached result once per change (and once at the deadline), without
      // starting another full health sweep or a recurring polling loop.
      const current = await connection.call<FleetStatusResult>(
        'fleet.status',
        {},
        { timeoutMs: Math.min(waitMs, 5000) },
      );
      slot = current.fleet.slots.find((value) => value.slot === slotId);
      if (timedOut && !slot?.workspace)
        throw new Error(
          slot?.workspaceError ||
            `Workspace inspection for ${slotId} did not finish within ${waitMs}ms`,
        );
    }
    return slot.workspace;
  } finally {
    clearTimeout(timer);
    unsubscribe();
    connection.close();
  }
}
