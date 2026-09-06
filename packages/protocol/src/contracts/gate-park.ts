/**
 * Gate-park state for clients (ADR-054 `free-slot` at an operator wait).
 *
 * A run parked with `free-slot` keeps its gate answerable while its slot goes
 * back to dispatch. Three facts then live in three different places — the park
 * record's slot disposition, the restore stages the record owes, and the
 * Gateway's verdict on whether the original slot can take the run back — and a
 * surface that reads any one of them alone gets the run's state wrong:
 *
 *   - occupancy alone reports a restore that re-bound the slot and then failed
 *     as "back", so the gate looks answerable against a worker nothing proved;
 *   - the phase alone reports a `partial` that never reached the slot the same
 *     way as one that freed it;
 *   - a client that decides slot availability itself picks a slot the Gateway
 *     did not, which is the one thing ADR-054 forbids.
 *
 * So this module owns the single reading, and Command Center, Companion, and
 * the CLI all render it. Availability is never derived here: it is carried in
 * from a Gateway verdict, or reported as not known.
 *
 * The predicates below moved out of the Gateway so clients share the exact
 * definitions the Gateway acts on rather than approximations of them.
 */
import {
  MACHINE_PARK_RESTORE_STAGES,
  type MachineParkPhase,
  type MachineParkRecord,
  type MachineParkRestoreRefusal,
  type MachineParkRestoreStage,
  type MachineParkSlotDisposition,
  type MachineParkWorkspace,
  type Run,
} from './runs.js';

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
  // `restored` is the ONLY thing that ends the obligation. Not the stage list:
  // every stage can be complete and the record still be `partial`, because the
  // orchestration resume after them failed — and reading the stages as done
  // there left the run unable to answer its gate and unable to be restored
  // through it. Not the residuals either: a reload that started the worker and
  // lost its acknowledgement leaves an occupied slot and a running process.
  if (park.phase === 'restored' || park.phase === 'cancelled') return false;
  if (park.mode !== 'release' || park.slotDisposition !== 'freed') return false;
  // The park itself is still landing. There is nothing coherent to restore
  // into yet, and the in-flight fence covers that case instead.
  //
  // Everything else got PAST the park: it freed the slot, or a restore already
  // re-bound it. A record written before stages were tracked lands here through
  // `slotReboundAt` — it cleared its freed marker at the rebind, so that is the
  // only fact left saying a restore touched it.
  //
  // A park that settled without reaching the slot at all is deliberately NOT
  // here. It owes no freed-slot stages, and the outstanding-effect fence below
  // is the right guard for it: it can still leave a run answerable where it
  // stands when the park stopped nothing.
  return Boolean(park.slotFreedAt) || Boolean(park.slotReboundAt);
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
 *   - the record owes a restore — it freed the slot, or a restore re-bound it
 *     and has not settled `restored`. Fenced, until that restore or a cancel.
 *   - a park that never reached the slot and settled `partial` — it will not
 *     finish. It is still fenced
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
  // Everything that still owes a restore is fenced, by construction rather than
  // by two lists of conditions that have to be kept in step. A gate that can be
  // answered while a restore is outstanding is the whole failure this guards,
  // and `needsGateParkRestore` already covers every freed or re-bound record —
  // so what remains below is only the park that never reached the slot.
  if (needsGateParkRestore(run)) return true;
  if (park.mode !== 'release' || park.slotDisposition !== 'freed') return false;
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

/**
 * Where the run's slot stands under its park record.
 *
 * `freeing` and `freed` are deliberately different words: the first is a park
 * whose release has not landed, and calling it freed would advertise a slot
 * whose worker is still being stopped. `restoring` is likewise not `freed`:
 * the slot is back under the run, but the restore still owes stages.
 *
 * The two `partial` states are split for the same reason, and it is the split
 * that matters most to an operator. A `partial` park has SETTLED — it will not
 * finish — so calling it "still landing" promises a completion that is never
 * coming, and telling the operator to wait is advice that cannot work. Which of
 * the two it is comes from the Gateway's own fence, never from a second reading
 * of the record: a partial that detached nothing and left an observably live
 * worker is answerable where it stands, and every other partial owes an
 * explicit restore before its gate may be answered.
 */
export type GateParkSlotState =
  /** A park that holds the run's slot — the machine-wide pause of ADR-053. */
  | 'retained'
  /** A freeing park still in flight; its slot release has not landed yet. */
  | 'freeing'
  /**
   * A freeing park that failed before it reached the slot and left nothing
   * outstanding. The worker is observably running and the gate is answerable.
   */
  | 'partial-answerable'
  /**
   * A freeing park that failed with an effect outstanding — a detach not rolled
   * back, or a worker that is not provably alive. Only a restore clears it.
   */
  | 'partial-needs-restore'
  /** The slot is released; dispatch may select it while the run stays parked. */
  | 'freed'
  /** A restore re-bound the slot but still owes stages before the gate is answerable. */
  | 'restoring'
  /** The record is `restored` or `cancelled`; nothing is outstanding. */
  | 'settled';

/** How far the current freed-slot restore attempt got. */
export interface GateParkRestoreStageView {
  state: 'not-started' | 'in-progress' | 'complete';
  /** The stage being attempted right now, written before it runs. */
  attempting: MachineParkRestoreStage | null;
  completed: readonly MachineParkRestoreStage[];
  /** Stages still owed, in the order the restore owes them. */
  remaining: readonly MachineParkRestoreStage[];
}

/**
 * The slot a restore would put the run back into.
 *
 * `available` is `null` when nothing has told this client whether that slot can
 * take the run back. Only the Gateway answers that question — through
 * `machine.pause.restore` — so a surface without one reports "not known" rather
 * than guessing from the record. ADR-054 restores into the ORIGINAL slot only,
 * which is why there is deliberately no alternative target here.
 */
export interface GateParkRestoreTargetView {
  slotId: string;
  disposition: MachineParkSlotDisposition;
  available: boolean | null;
  /** The Gateway's verdict code for that availability, when one was supplied. */
  code?: string;
  reason?: string;
}

/** How a restore proved the worker came back. */
export interface GateParkWorkerProofView {
  /** `structured` delivered a turn the runner acknowledged; `adopted` inherited a live session. */
  kind: 'structured' | 'adopted';
  reason: string;
  acceptedAt: string;
}

/** One reading of a run's gate park, shared by every client surface. */
export interface GateParkView {
  runId: string;
  machine: string;
  /** The park record's slot — the run's slot binding while the record is live. */
  slotId: string;
  phase: MachineParkPhase;
  slotState: GateParkSlotState;
  /** Absent on records written before slot freeing existed; read as `retained`. */
  slotDisposition: MachineParkSlotDisposition;
  /** The slot dispatch may hand to another run right now, or `null`. */
  freedSlotId: string | null;
  slotFreedAt?: string;
  slotReboundAt?: string;
  /** The branch and tip a freeing park took out of the slot's working tree. */
  preservedWorkspace?: MachineParkWorkspace;
  /**
   * Whether answering this run's gate must restore the run first. The same
   * question `run.resolveDecision` asks before it consumes the decision.
   */
  restoreBeforeGateAnswer: boolean;
  restoreStage: GateParkRestoreStageView;
  restoreTarget: GateParkRestoreTargetView;
  /** Why the last restore attempt refused, when it refused without changing anything. */
  refusal?: MachineParkRestoreRefusal;
  /** How the last restore proved the worker back, once one did. */
  workerProof?: GateParkWorkerProofView;
}

/**
 * A Gateway-resolved restore target. Structural so this module keeps no
 * value-level dependency on the RPC layer, which imports these contracts.
 * `MachinePauseRestoreTarget` and `MachinePauseEligibility` satisfy it.
 */
export interface GateParkRestoreVerdict {
  target: { slotId: string; disposition: MachineParkSlotDisposition; available: boolean };
  eligibility?: { code: string; reason: string };
}

function slotStateOf(park: MachineParkRecord): GateParkSlotState {
  if (park.phase === 'restored' || park.phase === 'cancelled') return 'settled';
  if (park.mode !== 'release' || park.slotDisposition !== 'freed') return 'retained';
  if (park.slotFreedAt && !park.slotReboundAt) return 'freed';
  if (park.slotReboundAt) return 'restoring';
  // A `partial` never reached the slot AND has stopped trying, so it is not
  // "still landing". Whether its gate is answerable is not a second opinion
  // formed here — it is `isGateParkInFlightOrFreed`, the same predicate
  // `assertNotGateParked` fences the resolution on. Deriving it any other way
  // is how the surfaces came to tell an operator to wait for a park that had
  // already given up, on a run whose worker was alive and whose gate the
  // Gateway would have accepted.
  if (park.phase === 'partial') {
    return isGateParkInFlightOrFreed({ park }) ? 'partial-needs-restore' : 'partial-answerable';
  }
  // The write-ahead record declares the intent before any release effect lands.
  return 'freeing';
}

function restoreStageView(park: MachineParkRecord): GateParkRestoreStageView {
  const progress = park.restoreProgress;
  if (!progress) {
    return {
      state: 'not-started',
      attempting: null,
      completed: [],
      remaining: MACHINE_PARK_RESTORE_STAGES,
    };
  }
  const completed = MACHINE_PARK_RESTORE_STAGES.filter((stage) =>
    progress.completed.includes(stage),
  );
  const remaining = MACHINE_PARK_RESTORE_STAGES.filter(
    (stage) => !progress.completed.includes(stage),
  );
  // An attempted stage is in flight, not complete: the marker is written BEFORE
  // the stage runs, so a crash inside one is visible as unfinished rather than
  // as an absence. `complete` therefore requires every stage landed AND nothing
  // being attempted, which is `machineParkRestoreComplete`.
  const state =
    remaining.length === 0 && !progress.attempting
      ? 'complete'
      : completed.length === 0 && !progress.attempting
        ? 'not-started'
        : 'in-progress';
  return {
    state,
    attempting: progress.attempting ?? null,
    completed,
    remaining,
  };
}

/**
 * The one reading of a run's gate park, or `null` when the run has no park
 * record at all.
 *
 * `verdict` carries a Gateway-resolved restore target when the caller has read
 * one (`machine.pause.restore`). Without it the target's `available` stays
 * `null`: the record says which slot a restore would use, never whether that
 * slot is free right now.
 */
export function gateParkView(
  run: Pick<Run, 'id' | 'park'>,
  verdict?: GateParkRestoreVerdict,
): GateParkView | null {
  const park = run.park;
  if (!park) return null;
  const disposition = park.slotDisposition ?? 'retained';
  const slotState = slotStateOf(park);
  const proof = park.recoveryProof;
  return {
    runId: run.id,
    machine: park.machine,
    slotId: park.slotId,
    phase: park.phase,
    slotState,
    slotDisposition: disposition,
    freedSlotId: isSlotFreedByPark({ park }) ? park.slotId : null,
    ...(park.slotFreedAt ? { slotFreedAt: park.slotFreedAt } : {}),
    ...(park.slotReboundAt ? { slotReboundAt: park.slotReboundAt } : {}),
    ...(park.preservedWorkspace ? { preservedWorkspace: park.preservedWorkspace } : {}),
    restoreBeforeGateAnswer: needsGateParkRestore({ park }),
    restoreStage: restoreStageView(park),
    restoreTarget: {
      slotId: verdict?.target.slotId ?? park.slotId,
      disposition: verdict?.target.disposition ?? disposition,
      available: verdict ? verdict.target.available : null,
      ...(verdict?.eligibility ? { code: verdict.eligibility.code } : {}),
      ...(verdict?.eligibility ? { reason: verdict.eligibility.reason } : {}),
    },
    ...(park.restoreRefusal ? { refusal: park.restoreRefusal } : {}),
    ...(proof
      ? {
          workerProof: {
            kind: proof.acknowledgement.kind,
            reason: proof.acknowledgement.reason,
            acceptedAt: proof.acceptedAt,
          },
        }
      : {}),
  };
}

/**
 * The gate park a client should render beside a run's gate, or `null` when
 * there is nothing outstanding to say.
 *
 * A settled record is deliberately excluded: it describes a park the operator
 * already resolved, and showing it beside a live gate reads as "this run is
 * parked" when it is not.
 */
export function liveGateParkView(
  run: Pick<Run, 'id' | 'park'>,
  verdict?: GateParkRestoreVerdict,
): GateParkView | null {
  const view = gateParkView(run, verdict);
  if (!view || view.slotState === 'settled') return null;
  return view;
}

/**
 * Operator wording for the run's slot under its park.
 *
 * The sentences live here rather than in each client because the same claim has
 * to read the same way in Command Center, Companion, and the CLI. A per-client
 * copy is how "parked" came to mean the slot was gone on one surface and still
 * held on another.
 */
export function gateParkStateLabel(view: GateParkView): string {
  if (view.slotState === 'retained') return 'Parked, slot retained';
  if (view.slotState === 'freeing') return 'Parking, slot not freed yet';
  // Neither partial says "parking": the park stopped, and the difference
  // between the two is the only thing that tells the operator what to do next.
  if (view.slotState === 'partial-answerable') {
    return 'Park failed before the slot; worker still running';
  }
  if (view.slotState === 'partial-needs-restore') return 'Park failed partway; needs a restore';
  if (view.slotState === 'freed') return 'Parked, slot freed for dispatch';
  if (view.slotState === 'restoring') return 'Restoring into its slot';
  return 'Park settled';
}

/** One compact line: what the park did with the slot, the branch it preserved, what it still owes. */
export function gateParkSummaryLine(view: GateParkView): string {
  const parts = [gateParkStateLabel(view), `slot ${view.slotId}`];
  if (view.preservedWorkspace) {
    const workspace = view.preservedWorkspace;
    parts.push(
      `branch ${workspace.branch} at ${workspace.headSha}${workspace.detachedAt ? ' (detached)' : ''}`,
    );
  }
  if (view.restoreStage.remaining.length && view.restoreStage.state !== 'not-started') {
    parts.push(`restore owes ${view.restoreStage.remaining.join(', ')}`);
  }
  if (view.restoreStage.attempting) parts.push(`attempting ${view.restoreStage.attempting}`);
  if (view.workerProof) parts.push(`worker ${view.workerProof.kind}`);
  return parts.join(' · ');
}

/**
 * What the operator must know before answering this run's gate, or `null` when
 * the park has nothing to say about it.
 *
 * A refused restore is reported as a block on the answer, never as a failed
 * run: the record stays parked, the decision stays pending, and the operator
 * can answer again once the refusal clears — or cancel.
 *
 * `blocking` is carried rather than left to each client to infer from `kind`.
 * A client that re-derives it gets the one case that matters backwards: a
 * `partial` park that stopped short of the slot is a warning worth showing and
 * is NOT a block, so styling every non-`restore-first` notice as a block puts
 * a stop sign on a gate the Gateway will accept.
 */
export interface GateParkGateNotice {
  kind:
    | 'restore-first'
    | 'restore-blocked'
    | 'park-in-flight'
    | 'park-needs-restore'
    | 'park-answerable';
  /** Whether this notice stands between the operator and answering the gate. */
  blocking: boolean;
  message: string;
  /** The typed refusal the last restore attempt recorded. */
  refusal?: MachineParkRestoreRefusal;
  /**
   * A Gateway verdict says the target IS available now, so the refusal above
   * describes a previous attempt rather than the current answer. Without this
   * a refusal that has since been overtaken keeps reading as a standing block.
   */
  refusalSuperseded?: boolean;
}

export function gateParkGateNotice(view: GateParkView | null): GateParkGateNotice | null {
  if (!view) return null;
  if (view.slotState === 'freeing') {
    return {
      kind: 'park-in-flight',
      blocking: true,
      message:
        'A free-slot park is still landing for this run, so its gate cannot be answered yet.',
    };
  }
  if (view.slotState === 'partial-needs-restore') {
    return {
      kind: 'park-needs-restore',
      blocking: true,
      // Deliberately says what to DO. This park has stopped, so "wait" is the
      // one instruction that cannot work, and it is what the old copy gave.
      message: `A free-slot park failed partway and left an effect outstanding, so this gate cannot be answered until a restore settles it. Waiting will not clear it — restore the run into ${view.slotId}, or cancel it.`,
      ...(view.refusal ? { refusal: view.refusal } : {}),
    };
  }
  if (view.slotState === 'partial-answerable') {
    return {
      kind: 'park-answerable',
      blocking: false,
      message: `A free-slot park failed before it reached ${view.slotId} and left the worker running, so this gate can be answered where it stands.`,
      ...(view.refusal ? { refusal: view.refusal } : {}),
    };
  }
  if (!view.restoreBeforeGateAnswer) return null;
  const target = view.restoreTarget;
  // `available === null` is "not known", never "unavailable": only a Gateway
  // verdict answers it, and treating an unread answer as a block would stand in
  // the operator's way for a restore that would have succeeded.
  //
  // A recorded refusal is likewise not a current verdict. It says the LAST
  // attempt refused, which is the best thing known only while nothing newer has
  // looked; an `available: true` verdict is newer by construction, and letting
  // a stale refusal outrank it blocks a restore the Gateway just approved.
  if (target.available === false) {
    return {
      kind: 'restore-blocked',
      blocking: true,
      message: `Answering this gate restores the run into ${target.slotId} first, and the Gateway reports that slot cannot take it back.${target.reason ? ` ${target.reason}` : ''}`,
      ...(view.refusal ? { refusal: view.refusal } : {}),
    };
  }
  if (target.available === null && view.refusal) {
    return {
      kind: 'restore-blocked',
      blocking: true,
      message: `Answering this gate restores the run into ${target.slotId} first, and the last restore attempt refused. Nothing has re-checked that slot since.`,
      refusal: view.refusal,
    };
  }
  return {
    kind: 'restore-first',
    blocking: false,
    message: `Answering this gate restores the run into ${target.slotId} first, then resolves the decision.`,
    ...(view.refusal ? { refusal: view.refusal, refusalSuperseded: true } : {}),
  };
}
