import type { SlotStatus } from '@farmslot/protocol';
import { fleetRecoverySummary, type FleetRefreshRow } from '@farmslot/review-dispatch';

export const FLEET_RELEASE_LABEL = 'Release and update to main';

export interface FleetReleaseScope {
  /** The slots the release review opens on. */
  slotIds: string[];
  label: string;
  title: string;
  /** Why the action is disabled, short enough to show beside it; empty when enabled. */
  reason: string;
  /** Some shown slot is a candidate for bulk release after inspection. */
  eligible: boolean;
  disabled: boolean;
}

/**
 * The fleet's one bulk action covers only the selected table rows that are still visible. It
 * never widens to unselected slots: no selection, or a selection the filters hide, disables it.
 * Opening review is read-only. The review obtains current release authority separately.
 */
export function fleetReleaseScope(
  visible: readonly SlotStatus[],
  selected: ReadonlySet<string>,
  selectable = true,
): FleetReleaseScope {
  const chosen = visible.filter((slot) => selected.has(slot.slot));
  const { count, canInspect } = fleetRecoverySummary(chosen);
  const [reason, title] = !selectable
    ? ['Switch to the table to select', 'Switch to the table to select slots to release']
    : !selected.size
      ? ['Select slots to release', 'Select slots to release']
      : !chosen.length
        ? ['Selection hidden by filters', 'The selected slots are hidden by the current filters']
        : !canInspect
          ? [
              'Selected slots can’t be released',
              'No selected slot can be released — each is busy, held, or disabled',
            ]
          : [
              '',
              `Review the ${chosen.length} selected slot${chosen.length === 1 ? '' : 's'} before releasing`,
            ];
  return {
    slotIds: chosen.map((slot) => slot.slot),
    label: chosen.length
      ? `${FLEET_RELEASE_LABEL} (${chosen.length} selected)`
      : FLEET_RELEASE_LABEL,
    title,
    reason,
    eligible: count > 0,
    disabled: reason !== '',
  };
}

/** Drop selected ids that left the fleet; the same set when nothing left. */
export function pruneFleetSelection(
  selected: ReadonlySet<string>,
  slots: readonly SlotStatus[],
): ReadonlySet<string> {
  const present = new Set(slots.map((slot) => slot.slot));
  return [...selected].every((slotId) => present.has(slotId))
    ? selected
    : new Set([...selected].filter((slotId) => present.has(slotId)));
}

/** One line naming the slots whose local work keeps them out of the bulk release. */
export function fleetLocalWorkNote(
  rows: readonly Pick<FleetRefreshRow, 'slotId' | 'eligibility' | 'status'>[],
): string {
  const held = rows
    .filter((row) => row.eligibility.confirmationRequired && row.status !== 'refreshed')
    .map((row) => row.slotId);
  if (!held.length) return '';
  return `Unpushed or uncommitted work on ${held.join(', ')}. Bulk release skips ${held.length === 1 ? 'it' : 'them'}.`;
}

export function setFleetSelection(
  selected: ReadonlySet<string>,
  slotIds: readonly string[],
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const slotId of slotIds) {
    if (on) next.add(slotId);
    else next.delete(slotId);
  }
  return next;
}
