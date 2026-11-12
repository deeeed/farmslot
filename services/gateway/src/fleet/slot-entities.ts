// Slot entities for entity sync (ADR-071 Amendment 3). Each served slot and its version are
// maintained where the slot is written: a status commit or load, and every overlay write. A
// publication or a read looks them up; neither hashes nor rebuilds the fleet.
import {
  computeSummary,
  type FleetEntityPage,
  type FleetVersionsResult,
  type SlotEntity,
  type SlotStatus,
} from '@farmslot/protocol';
import { canonicalResourceJson, type ResourceKey } from '@farmslot/protocol/client-cache';

import { markFailedSlotUnverified, observedSlotWorkspace } from '../methods/slot/workspace.js';
import { entityVersionHash } from '../resources/entity-version-hash.js';
import { type EntitySnapshot, resourceRevisions } from '../resources/revisions.js';
import { slotResourceChanges } from '../resources/slot-run-bindings.js';

import { getAllMachineHealth } from './node-health.js';
import { ensureFleetLoaded, overlaySlotEntity, slotEntityBase } from './state.js';

/** An ids page stops before the slot that would take it past this many UTF-8 JSON bytes. */
export const FLEET_ENTITY_PAGE_MAX_BYTES = 2 * 1024 * 1024;

export const FLEET_COLLECTION_KEY: ResourceKey = { family: 'slots', scope: 'farm' };

interface SlotRecord {
  entity: SlotEntity;
  version: string;
  bytes: number;
}

const records = new Map<string, SlotRecord>();
let order: string[] = [];
let listing: string | undefined;
let servedBase: object | undefined;
const baseIndex = new WeakMap<object, Map<string, SlotStatus>>();

/** A slot as the observed fleet read serves it, without host load (machine samples own that). */
function servedSlotEntity(base: SlotStatus): SlotEntity {
  const overlaid = overlaySlotEntity(base);
  const { hostLoad: _hostLoad, ...entity } = markFailedSlotUnverified(
    overlaid,
    observedSlotWorkspace(overlaid),
  );
  return entity;
}

function indexOf(slots: readonly SlotStatus[], fleet: object): Map<string, SlotStatus> {
  let index = baseIndex.get(fleet);
  if (!index) {
    index = new Map(slots.map((slot) => [slot.slot, slot]));
    baseIndex.set(fleet, index);
  }
  return index;
}

/** Recomputes these slots' entities (every slot when undefined or on a new base). */
function refresh(slotIds: readonly string[] | undefined): void {
  const fleet = slotEntityBase();
  if (!fleet) return;
  const bases = indexOf(fleet.slots, fleet);
  const all = slotIds === undefined || servedBase === undefined;
  const ids = all ? new Set([...bases.keys(), ...records.keys()]) : new Set(slotIds);
  servedBase = fleet;
  for (const id of ids) {
    const base = bases.get(id);
    if (!base) {
      records.delete(id);
      continue;
    }
    const entity = servedSlotEntity(base);
    records.set(id, {
      entity,
      version: entityVersionHash(entity),
      bytes: Buffer.byteLength(JSON.stringify(entity)),
    });
  }
  // The listing's order and the fleet's non-entity fields reach clients by a versions read.
  const nextOrder = fleet.slots.map((slot) => slot.slot);
  const next = canonicalResourceJson({ order: nextOrder, poolErrors: fleet.poolErrors ?? [] });
  if (next !== listing) {
    if (listing !== undefined) resourceRevisions.advanceMembership(FLEET_COLLECTION_KEY);
    listing = next;
    order = nextOrder;
  }
}

slotResourceChanges.setEntityRefresh(refresh);
resourceRevisions.registerEntityCollection(
  (key) =>
    key.family === 'slots' &&
    canonicalResourceJson(key) === canonicalResourceJson(FLEET_COLLECTION_KEY),
);

/** The maintained slot behind a slot key, for publication. */
export function slotEntityProvider(key: ResourceKey): EntitySnapshot | undefined {
  const record = key.family === 'slot' ? records.get(key.slotId) : undefined;
  return record ? { family: 'slot', ...record } : undefined;
}
resourceRevisions.setEntityProvider('slot', slotEntityProvider);

async function current(): Promise<NonNullable<ReturnType<typeof slotEntityBase>>> {
  await ensureFleetLoaded();
  if (servedBase === undefined) refresh(undefined);
  const fleet = slotEntityBase();
  if (!fleet) throw new Error('The fleet has no committed rows');
  return fleet;
}

/** `fleet.status { versions: true }`: stored versions and the fleet's non-entity fields. */
export async function fleetStatusVersions(): Promise<FleetVersionsResult> {
  const fleet = await current();
  const held = order.flatMap((id) => {
    const record = records.get(id);
    return record ? [{ id, record }] : [];
  });
  const machines = getAllMachineHealth();
  return {
    versions: held.map(({ id, record }) => ({ id, version: record.version })),
    summary: computeSummary(held.map(({ record }) => record.entity)),
    ...(machines.length ? { machines } : {}),
    checkedAt: fleet.checkedAt,
    ...(fleet.poolErrors?.length ? { poolErrors: fleet.poolErrors } : {}),
    membershipRevision: resourceRevisions.membershipRevision(FLEET_COLLECTION_KEY),
  };
}

/** `fleet.status { ids }`: the named slots that exist, in request order, within the byte cap. */
export async function fleetStatusIds(ids: readonly string[]): Promise<FleetEntityPage> {
  await current();
  const page: FleetEntityPage = { entities: [], versions: [] };
  let bytes = 0;
  for (const id of ids) {
    const record = records.get(id);
    if (!record) continue;
    if (page.entities.length > 0 && bytes + record.bytes > FLEET_ENTITY_PAGE_MAX_BYTES) break;
    bytes += record.bytes;
    page.entities.push(record.entity);
    page.versions.push({ id, version: record.version });
  }
  return page;
}
