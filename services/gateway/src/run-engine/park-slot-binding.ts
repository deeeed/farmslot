import { machineParkRestoreComplete, type Run } from '@farmslot/protocol';

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
  const park = run.park;
  if (!park?.slotFreedAt) return false;
  // `slotReboundAt` is the counterpart fact, and it is what ends the release.
  // `slotFreedAt` deliberately survives the whole restore — it is what tells a
  // retry which stages it still owes — so reading it alone would report a slot
  // the run is sitting in as free for dispatch.
  return !park.slotReboundAt;
}

/**
 * Whether a gate park still owes a restore before its gate may be answered.
 *
 * The question consumption asks, and it is NOT "does the run occupy its slot".
 * A restore that re-bound the slot, booted its resources, and then failed to
 * get a structured acknowledgement out of the worker leaves an occupied slot
 * and a running process — and answering the gate there drives the engine
 * against a worker that never confirmed it came back. So this keys on the
 * restore's own stage record, which is the only thing that says what landed.
 */
export function needsGateParkRestore(run: Pick<Run, 'park'>): boolean {
  const park = run.park;
  if (!park) return false;
  if (park.phase === 'restored' || park.phase === 'cancelled') return false;
  if (park.mode !== 'release' || park.slotDisposition !== 'freed') return false;
  // A restore that STARTED owes the rest of its stages, whatever the record's
  // occupancy says now. This is the case a record written before restores
  // tracked their stages also lands in: it cleared the freed marker at its
  // first stage, so nothing else is left that says the restore is unfinished.
  if (park.restoreProgress) return !machineParkRestoreComplete(park.restoreProgress);
  // No restore has started, so only a park that actually freed the slot owes
  // one. A park still landing is the in-flight fence's business, not a
  // restore's: there is nothing coherent to restore into yet.
  return Boolean(park.slotFreedAt);
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
 *   - record settled `partial` — the park will not finish. It is still fenced
 *     while ANY of its effects is outstanding: a detach not yet rolled back, or
 *     a runner that is not PROVABLY still running. A stopped worker cannot act
 *     on a gate answer, and letting the operator answer anyway would be the
 *     silent version of the strand. `machine.pause.restore` is the exit: it
 *     reloads the worker and settles the record, which lifts the fence. Only a
 *     park that detached nothing and left an observably live worker leaves the
 *     run answerable where it stands.
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
  // A restore that started and did not finish every stage it owes. Its slot may
  // be back and its worker may even be running, so nothing about the run's
  // occupancy says it is safe to answer the gate — only the stage record does.
  if (park.restoreProgress && !machineParkRestoreComplete(park.restoreProgress)) return true;
  if (park.phase === 'partial') {
    if (park.preservedWorkspace?.detachedAt) return true;
    // The park stops the runner before it ever touches the slot, so a partial
    // that got past that point has a dead worker even though the run still owns
    // its slot. Restore is what brings it back.
    //
    // `unknown` fences too, and that direction matters: it means the probe
    // could not see the worker, which for a failure before the re-host is the
    // NORMAL answer — the recorded handle still names the pane a successor
    // destroyed. Reading "could not observe" as "still running" lifts the fence
    // on a dead worker, and the next gate answer runs FINALIZE against it. Only
    // an observed live worker leaves the run answerable.
    return park.residuals?.runner !== 'running';
  }
  return true;
}

/**
 * Whether machine parking still holds this run.
 *
 * The park RECORD is the authority for "is this run parked", not the run's
 * persisted posture. A restore or a cancel settles the record while the posture
 * it was applied under stays on the run, so a reader that trusts the posture
 * decides an already-restored run is still parked — and then refuses to park it
 * again, forever, as a no-op.
 */
export function hasLiveParkRecord(run: Pick<Run, 'park'>): boolean {
  const park = run.park;
  if (!park) return false;
  return park.phase !== 'restored' && park.phase !== 'cancelled';
}
