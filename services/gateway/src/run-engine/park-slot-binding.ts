import type { Run } from '@farmslot/protocol';

/**
 * Whether this run's machine-park record released its slot (ADR-054
 * `free-slot` at an operator wait, amending ADR-038's gate-held slot hold).
 *
 * `slotFreedAt` records the fact, not the intent: it is written only after the
 * park stopped the runner and every manifest resource AND the ownership
 * release landed, so a partial park never reads as freed. While it is set, the
 * park record — not the slot row — is the authority for the run's slot
 * binding: the run keeps `slotId` (the recovery handle and the workspace
 * branch key off it) but stops counting as an occupant of that slot.
 *
 * Lives in its own leaf module so slot scoring and fleet refresh can share the
 * one definition without pulling in the gate-held teardown import chain.
 */
export function isSlotFreedByPark(run: Pick<Run, 'park'>): boolean {
  return Boolean(run.park?.slotFreedAt);
}
