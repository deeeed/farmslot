import {
  canonicalResourceJson,
  type ResourceKey,
  resourceKeyId,
} from '@farmslot/protocol/client-cache';

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
  private failed = false;

  constructor(private readonly revisions: GatewayResourceRevisions = resourceRevisions) {}

  observe(slots: readonly SlotResourceSnapshot[]): void {
    const current = new Map(slots.map((row) => [row.slot, { ...row }]));
    const previous = this.previous;
    const ids = [...new Set([...(previous?.keys() ?? []), ...current.keys()])];
    const changed = ids.filter(
      (id) => this.failed || previous?.get(id)?.fingerprint !== current.get(id)?.fingerprint,
    );
    if (!previous || this.failed || changed.length)
      this.invalidateSlots(changed, current, previous);
    if (
      !previous ||
      this.failed ||
      ids.some((id) => previous.get(id)?.currentRunId !== current.get(id)?.currentRunId)
    )
      this.invalidateBindings();
    this.previous = current;
    this.failed = false;
  }

  unavailable(): void {
    if (!this.failed) {
      this.invalidateSlots([...(this.previous?.keys() ?? [])], this.previous);
      this.invalidateBindings();
    }
    this.failed = true;
  }

  private invalidateSlots(
    ids: readonly string[],
    current?: ReadonlyMap<string, SlotResourceSnapshot>,
    previous?: ReadonlyMap<string, SlotResourceSnapshot>,
  ): void {
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
    for (const key of keys.values())
      this.revisions.advance(
        key,
        key.family === 'slot' && !current?.has(key.slotId) ? 'deleted' : 'updated',
      );
  }

  private invalidateBindings(): void {
    // Selection and gate projections may use former or implicit slot owners.
    // Broad invalidation keeps those readers current without guessing a run ID.
    this.revisions.advance({ family: 'runs', scope: 'farm' });
    this.revisions.advance({ family: 'decisions', scope: 'farm' });
  }
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
