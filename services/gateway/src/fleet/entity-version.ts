import { createHash } from 'node:crypto';

import type { SlotEntity, SlotStatus } from '@farmslot/protocol';
import { canonicalResourceJson } from '@farmslot/protocol/client-cache';
import type { ChangedEntity } from '@farmslot/protocol/transport/events';

import { getCachedFleet } from './state.js';

/**
 * Synchronous entity provider for { family: 'slot', slotId } keys.
 * Called by GatewayResourceRevisions.publish() on each slot change.
 *
 * Excludes hostLoad from the entity body and version hash — hostLoad is derived
 * from MachineHealth and re-attached by the client cache from the machines array.
 * Keeping it out of the entity prevents version churn on node-health refreshes.
 */
export function slotEntityProvider(slotId: string): ChangedEntity | undefined {
  const fleet = getCachedFleet();
  if (!fleet) return undefined;
  const slot = fleet.slots.find((s) => s.slot === slotId);
  if (!slot) return undefined;
  const entity = slotEntityBody(slot);
  const version = slotEntityVersion(entity);
  return { family: 'slot', entity, version };
}

/** Slot entity body: SlotStatus with hostLoad excluded. */
export function slotEntityBody(slot: SlotStatus): SlotEntity {
  if (!('hostLoad' in slot)) return slot;
  const { hostLoad: _excluded, ...rest } = slot;
  return rest;
}

/** Content-hash version for a slot entity body. Full sha256 hex (64 chars). Stable across gateway restarts. */
export function slotEntityVersion(entity: SlotEntity): string {
  return createHash('sha256').update(canonicalResourceJson(entity)).digest('hex');
}
