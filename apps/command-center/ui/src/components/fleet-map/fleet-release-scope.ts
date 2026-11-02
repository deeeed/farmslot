import type { SlotStatus } from '@farmslot/protocol';
import { fleetRecoverySummary } from '@farmslot/review-dispatch';

export const FLEET_RELEASE_LABEL = 'Release and update to main';

export interface FleetReleaseScope {
  /** The slots the release review opens on. */
  slotIds: string[];
  label: string;
  title: string;
  /** Some slot in scope can be released in bulk right now. */
  eligible: boolean;
  disabled: boolean;
}

/** The fleet's one bulk action: the table's selection, or every visible slot when none is selected. */
export function fleetReleaseScope(
  visible: readonly SlotStatus[],
  selected: ReadonlySet<string>,
): FleetReleaseScope {
  const chosen = visible.filter((slot) => selected.has(slot.slot));
  const scope = chosen.length ? chosen : visible;
  const { count, canInspect } = fleetRecoverySummary(scope);
  const label = chosen.length
    ? `${FLEET_RELEASE_LABEL} (${chosen.length} selected)`
    : count
      ? `${FLEET_RELEASE_LABEL} (${count})`
      : FLEET_RELEASE_LABEL;
  const title = !canInspect
    ? chosen.length
      ? 'No selected slot can be released — each is busy, held, or disabled'
      : 'No eligible slots — every slot is busy, held, or disabled'
    : chosen.length
      ? `Review the ${chosen.length} selected slot${chosen.length === 1 ? '' : 's'} before releasing`
      : 'Review idle slots before releasing; select rows in the table to narrow this';
  return {
    slotIds: scope.map((slot) => slot.slot),
    label,
    title,
    eligible: count > 0,
    disabled: !canInspect,
  };
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
