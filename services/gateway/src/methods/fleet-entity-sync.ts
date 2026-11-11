/**
 * Entity-sync handlers for fleet.status (ADR-071 Amendment 3).
 * Routes: fleet.status { versions: true } and fleet.status { ids: string[] }.
 */
import type { FleetEntityPage, FleetVersionsResult } from '@farmslot/protocol';

import { slotEntityBody, slotEntityVersion } from '../fleet/entity-version.js';
import { getCachedFleet, loadFleetStatus } from '../fleet/state.js';

export const FLEET_ENTITY_PAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * fleet.status { versions: true }
 * Returns the id/version list plus non-entity fields (summary, machines, checkedAt).
 * No entity bodies in the response.
 */
export async function fleetStatusVersions(): Promise<FleetVersionsResult> {
  // Use cached fleet if available, else load fresh.
  const fleet = getCachedFleet() ?? (await loadFleetStatus());
  const versions = fleet.slots.map((slot) => {
    const entity = slotEntityBody(slot);
    return { id: slot.slot, version: slotEntityVersion(entity) };
  });
  return {
    versions,
    summary: fleet.summary,
    ...(fleet.machines?.length ? { machines: fleet.machines } : {}),
    checkedAt: fleet.checkedAt,
    ...(fleet.poolErrors?.length ? { poolErrors: fleet.poolErrors } : {}),
  };
}

/**
 * fleet.status { ids: string[] }
 * Returns only the named slot entities (by slot id) plus their versions.
 * Uses FleetEntityPage, not FleetStatusResult — no fleet wrapper or empty fields.
 */
export async function fleetStatusIds(ids: string[]): Promise<FleetEntityPage> {
  const fleet = getCachedFleet() ?? (await loadFleetStatus());
  const slotMap = new Map(fleet.slots.map((s) => [s.slot, s]));
  const entities = [];
  const versions = [];
  let bytes = 0;
  for (const id of ids) {
    const slot = slotMap.get(id);
    if (!slot) continue;
    const entity = slotEntityBody(slot);
    const version = slotEntityVersion(entity);
    const entryBytes = JSON.stringify(entity).length;
    if (bytes + entryBytes > FLEET_ENTITY_PAGE_MAX_BYTES && entities.length > 0) break;
    bytes += entryBytes;
    entities.push(entity);
    versions.push({ id, version });
  }
  return { entities, versions };
}
