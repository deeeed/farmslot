import type { SlotStatus } from '@farmslot/protocol';

import { type GatewayResourceRevisions, resourceRevisions } from './revisions.js';

type SlotRunBinding = Pick<SlotStatus, 'slot' | 'currentRunId'>;

/** The status writer and its filesystem observer share one scalar snapshot. */
export class SlotRunBindingChanges {
  private previous?: Map<string, string | null>;
  private failed = false;

  constructor(private readonly revisions: GatewayResourceRevisions = resourceRevisions) {}

  observe(slots: readonly SlotRunBinding[]): void {
    const current = new Map(slots.map(({ slot, currentRunId }) => [slot, currentRunId ?? null]));
    const previous = this.previous;
    const changed = [...new Set([...(previous?.keys() ?? []), ...current.keys()])].filter(
      (id) => !previous?.has(id) || !current.has(id) || previous.get(id) !== current.get(id),
    );
    if (!previous || this.failed || changed.length) this.invalidateCollections();
    for (const slotId of changed)
      this.revisions.advance(
        { family: 'slot', slotId },
        current.has(slotId) ? 'updated' : 'deleted',
      );
    this.previous = current;
    this.failed = false;
  }

  unavailable(): void {
    if (!this.failed) this.invalidateCollections();
    this.failed = true;
  }

  private invalidateCollections(): void {
    this.revisions.advance({ family: 'slots', scope: 'farm' });
    // Selection and gate projections may use former or implicit slot owners.
    // Broad invalidation keeps those readers current without guessing a run ID.
    this.revisions.advance({ family: 'runs', scope: 'farm' });
    this.revisions.advance({ family: 'decisions', scope: 'farm' });
  }
}

/** Validate only the bindings this migration owns; the fleet reader owns the rest. */
export function statusRunBindings(value: unknown): SlotRunBinding[] {
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
    return { slot, currentRunId: owner ?? null };
  });
}
