import {
  canonicalResourceJson,
  type ResourceKey,
  resourceKeyId,
} from '@farmslot/protocol/client-cache';

import { fleetStaleDeadline } from '../fleet/freshness.js';

import { type GatewayResourceRevisions, resourceRevisions } from './revisions.js';

interface SlotResourceSnapshot {
  slot: string;
  currentRunId: string | null;
  project?: string;
  nodeId?: string;
  fingerprint: string;
}

/** The status writer and its filesystem observer share one scalar snapshot. */
export class SlotResourceChanges {
  private previous?: Map<string, SlotResourceSnapshot>;
  private previousCheckedAt?: string;
  private ghosts = new Set<string>();
  private failed = false;

  constructor(private readonly revisions: GatewayResourceRevisions = resourceRevisions) {}

  observe(slots: readonly SlotResourceSnapshot[], checkedAt?: string): void {
    const current = new Map(slots.map((row) => [row.slot, { ...row }]));
    const previous = this.previous;
    const ids = [...new Set([...(previous?.keys() ?? []), ...current.keys()])];
    const changed = ids.filter(
      (id) => this.failed || previous?.get(id)?.fingerprint !== current.get(id)?.fingerprint,
    );
    const metadataChanged = !previous || this.failed || this.previousCheckedAt !== checkedAt;
    if (metadataChanged || changed.length)
      this.invalidateSlots(metadataChanged ? ids : changed, current, previous);
    if (
      !previous ||
      this.failed ||
      ids.some((id) => previous.get(id)?.currentRunId !== current.get(id)?.currentRunId)
    )
      this.invalidateBindings();
    this.previous = current;
    this.previousCheckedAt = checkedAt;
    this.failed = false;
    this.revisions.scheduleInvalidations(
      'fleet-status',
      this.slotKeys([...current.keys()], current),
      fleetStaleDeadline(checkedAt),
    );
  }

  /** Pool membership can change derived ghost/dispatch facts without a status-file commit. */
  observePool(liveIds: ReadonlySet<string>): void {
    const ghosts = new Set([...(this.previous?.keys() ?? [])].filter((id) => !liveIds.has(id)));
    for (const id of new Set([...this.ghosts, ...ghosts]))
      if (this.previous?.has(id) && this.ghosts.has(id) !== ghosts.has(id)) this.overlayChanged(id);
    this.ghosts = ghosts;
  }

  unavailable(): void {
    if (!this.failed) {
      this.invalidateSlots([...(this.previous?.keys() ?? [])], this.previous);
      this.invalidateBindings();
    }
    this.failed = true;
    this.revisions.scheduleInvalidations('fleet-status', [], undefined);
  }

  /** In-memory enrichments change slot facts without changing persisted run ownership. */
  overlayChanged(slotId: string): void {
    const row = this.previous?.get(slotId);
    const keys: ResourceKey[] = [
      { family: 'slots', scope: 'farm' },
      { family: 'slot', slotId },
    ];
    if (row?.project) keys.push({ family: 'slots', scope: 'farm', project: row.project });
    if (row?.nodeId) keys.push({ family: 'slots', scope: 'farm', nodeId: row.nodeId });
    for (const key of keys) this.revisions.advance(key);
  }

  private invalidateSlots(
    ids: readonly string[],
    current?: ReadonlyMap<string, SlotResourceSnapshot>,
    previous?: ReadonlyMap<string, SlotResourceSnapshot>,
  ): void {
    for (const key of this.slotKeys(ids, current, previous))
      this.revisions.advance(
        key,
        key.family === 'slot' && !current?.has(key.slotId) ? 'deleted' : 'updated',
      );
  }

  private slotKeys(
    ids: readonly string[],
    current?: ReadonlyMap<string, SlotResourceSnapshot>,
    previous?: ReadonlyMap<string, SlotResourceSnapshot>,
  ): ResourceKey[] {
    const keys = new Map<string, ResourceKey>();
    const add = (key: ResourceKey) => keys.set(resourceKeyId(key), key);
    add({ family: 'slots', scope: 'farm' });
    for (const slotId of ids) {
      add({ family: 'slot', slotId });
      for (const row of [previous?.get(slotId), current?.get(slotId)]) {
        if (row?.project) add({ family: 'slots', scope: 'farm', project: row.project });
        if (row?.nodeId) add({ family: 'slots', scope: 'farm', nodeId: row.nodeId });
      }
    }
    return [...keys.values()];
  }

  private invalidateBindings(): void {
    // Selection and gate projections may use former or implicit slot owners.
    // Broad invalidation keeps those readers current without guessing a run ID.
    this.revisions.advance({ family: 'runs', scope: 'farm' });
    this.revisions.advance({ family: 'decisions', scope: 'farm' });
  }
}

export const slotResourceChanges = new SlotResourceChanges();

export function statusCheckedAt(value: unknown): string | undefined {
  const checkedAt =
    value && typeof value === 'object' ? Reflect.get(value, 'checked_at') : undefined;
  return typeof checkedAt === 'string' ? checkedAt : undefined;
}

/** Capture scalar facts so a later in-place write cannot change the saved comparison. */
export function statusSlotResources(value: unknown): SlotResourceSnapshot[] {
  if (!value || typeof value !== 'object') throw new Error('Fleet status must contain slot rows');
  const rows = Reflect.get(value, 'slots');
  if (!Array.isArray(rows)) throw new Error('Fleet status must contain slot rows');
  const ids = new Set<string>();
  return rows.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid fleet slot binding');
    const slot = Reflect.get(row, 'slot');
    const owner = Reflect.get(row, 'current_run_id');
    if (
      typeof slot !== 'string' ||
      !slot ||
      ids.has(slot) ||
      (owner != null && typeof owner !== 'string')
    )
      throw new Error('Invalid fleet slot binding');
    ids.add(slot);
    const project = Reflect.get(row, 'project');
    const nodeId = Reflect.get(row, 'machine');
    return {
      slot,
      currentRunId: owner ?? null,
      ...(typeof project === 'string' && project ? { project } : {}),
      ...(typeof nodeId === 'string' && nodeId ? { nodeId } : {}),
      fingerprint: canonicalResourceJson(row),
    };
  });
}
