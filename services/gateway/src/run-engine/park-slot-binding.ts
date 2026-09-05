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
 * This is the OCCUPANCY predicate. It must never claim a slot is free before
 * the release actually landed, so dispatch cannot hand out a slot whose worker
 * is still running. Use `isGateParkInFlightOrFreed` for the safety fences,
 * which have the opposite bias.
 *
 * Lives in its own leaf module so slot scoring and fleet refresh can share the
 * one definition without pulling in the gate-held teardown import chain.
 */
export function isSlotFreedByPark(run: Pick<Run, 'park'>): boolean {
  return Boolean(run.park?.slotFreedAt);
}

/**
 * Whether a slot-freeing park is either done or still in flight for this run.
 *
 * The opposite bias to `isSlotFreedByPark`: it goes true the moment the
 * write-ahead record declares a freeing park and stays true through the window
 * where the runner and resources are being stopped but `slotFreedAt` has not
 * been written yet.
 *
 * Every guard that must not act on a run whose slot is disappearing uses this:
 * resolving a gate, applying a posture, driving a resolved gate onward, or
 * tearing the slot down after a failure. Answering a gate mid-park would
 * publish against a worker that is being stopped underneath it.
 *
 * It is keyed on intent-or-fact HONESTLY, which matters as much as the fence
 * itself. A fence that never lifts is not a fence, it is a strand: the run can
 * neither answer its gate nor be restored, and cancelling it is the only exit.
 * So:
 *
 *   - `slotFreedAt` set — the release landed. Fenced, until restore or cancel.
 *   - record settled `partial` with nothing landed — the park changed nothing
 *     (the usual case: the working tree went dirty between preview and detach,
 *     so the detach refused before touching anything). The run still owns its
 *     slot and its worker, so it stays answerable and restorable. Not fenced.
 *   - record settled `partial` with a detach still outstanding — one real
 *     effect is unreversed, so the fence holds until it is rolled back.
 *   - otherwise, while the intent is live — fenced.
 */
export function isGateParkInFlightOrFreed(run: Pick<Run, 'park'>): boolean {
  const park = run.park;
  if (!park) return false;
  // A record the operator already settled fences nothing, even though it still
  // carries the historical `slotFreedAt` of the release it undid.
  if (park.phase === 'restored' || park.phase === 'cancelled') return false;
  if (park.slotFreedAt) return true;
  if (park.mode !== 'release' || park.slotDisposition !== 'freed') return false;
  if (park.phase === 'partial') return Boolean(park.preservedWorkspace?.detachedAt);
  return true;
}
