import { setTimeout as delay } from 'node:timers/promises';

import {
  type DecisionAction,
  DEFAULT_BRANCH,
  type DispatchPreviewParams,
  Events,
  isDispatchScoreStale,
  ReviewQaConfigurationError,
  type Run,
  type RunDecision,
  type RunDecisionPayload,
  SLOT_DESTRUCTIVE_OPS,
  SLOT_STALE_BRANCH_SCORE_PENALTY,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import {
  claimSlotStatusIf,
  getProjectField,
  loadProjectVars,
  readSlotRow,
  resetSlotIf,
  SLOT_PHASE_RELEASING,
  transitionSlotStatus,
  updateSlotStatus,
} from '../core/index.js';
import { loadFleetStatus, loadProjectConfig, loadProjectConfigs } from '../fleet/state.js';
import {
  capturePressureAdmissionDecisionsLightweight,
  collectBranchAffinityNudgeCandidates,
  consumedPressureAdmissionRef,
  dispatchPreview,
  findAffinitySlot,
  prepareSlotForFreshReuse,
  PressureAdmissionRejectedError,
  refreshBranches,
  resolveExecutePressureOutcome,
  selectBranchAffinityRefreshSlots,
  verifyBranchAffinityNudgeStillEligible,
} from '../methods/dispatch.js';
import {
  inspectReleasableBranchHolders,
  releaseBranchHolderForSelection,
} from '../methods/dispatch/branch-checkout.js';
import {
  activeRunIds,
  activeRunSlotIds,
  companionResourceBlocker,
  isCdpLive,
  isFreeSlot,
  isReplaceableWarmSlot,
  parkPreservedSlotIds,
  pickedSlotIneligibility,
  prepareProfileNeedsCompanionResource,
  projectConfigsFromProjects,
  SLOT_CLAIM_REFUSED_CODE,
  slotClaimBlockedByRelease,
  slotClaimBlocker,
  slotRepoBlocker,
  slotScore,
  validateSlotForDispatch,
} from '../methods/dispatch/slot-scoring.js';
import {
  assertSlotNotOperatorRoot,
  resetSlotRepoToIdle,
  slotIdleResetStepDetail,
} from '../methods/slot/slot-tracking.js';
import { assertNativeSlotReplacementOwner } from '../runners/native/worker.js';
import {
  assertNativeProfileSlot,
  inspectNativeWorkerProfile,
  nativeProfileAllowedSlots,
} from '../runners/native/worker-profile.js';
import { runnerDefaultSafetyTier } from '../runners/registry.js';
import {
  getAllRuns,
  getAllRunsWithArchived,
  getRun,
  persistRunNow,
  updateRun,
  updateRunStep,
} from '../runs/store.js';
import {
  projectUsesExecutionTemplateCatalog,
  resolveConfiguredExecutionTemplateForSlot,
} from '../tasks/execution-template-catalog.js';
import { precheckTaskDirCollision } from '../tasks/writer.js';

import { BlockedRunError } from './errors.js';
import { canReconcileReviewQaRun, reviewQaMigrationPatch } from './review-qa-migration.js';
import { runSupersededSince } from './run-generation.js';

interface StepIO {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

type BroadcastFn = (event: string, payload: unknown) => void;

interface RunEngineFlags {
  skipPrepare?: true;
  nudgeReuse?: true;
  freshReuse?: true;
  warmSessionReuse?: true;
}

/**
 * Await a wait that blocks the step and record it as the step's queue time,
 * open (`queuedSince`) while it lasts. Timed around the await, so a decision an
 * earlier attempt already resolved replays at once and adds nothing. A waiter
 * that outlives a re-entry adds nothing either: that attempt times its own waits.
 */
export async function awaitAsQueueTime<T>(
  runId: string,
  stepName: string,
  wait: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const findStep = () => getRun(runId)?.steps.find((candidate) => candidate.name === stepName);
  const startedAt = findStep()?.startedAt;
  const sinceMs = now();
  const queuedSince = new Date(sinceMs).toISOString();
  if (findStep()) updateRunStep(runId, stepName, { queuedSince });
  try {
    return await wait();
  } finally {
    const step = findStep();
    if (step && step.startedAt === startedAt && step.queuedSince === queuedSince) {
      updateRunStep(runId, stepName, {
        queuedMs: (step.queuedMs ?? 0) + Math.max(0, now() - sinceMs),
        queuedSince: undefined,
      });
    }
  }
}

export interface FindSlotStepContext {
  broadcastFn: BroadcastFn;
  buildDispatchPreviewParamsForRun: (run: Run) => DispatchPreviewParams;
  createEngineDecision: (
    runId: string,
    reason: string,
    description: string,
    actions: DecisionAction[],
    payload?: RunDecisionPayload,
    options?: { canReplay?: (existing: RunDecision) => boolean },
  ) => Promise<string>;
  determineSelectionMethodForRun: (
    run: Pick<Run, 'flowType'>,
    requestedSlotId: string | undefined,
    projectSlots: Array<Pick<Run, never> & { lifecycle: string; slot: string }>,
    slotId: string,
  ) => 'user-specified' | 'affinity' | 'scored';
  handleCollisionDecision: (
    runId: string,
    current: Run,
    existingDirs: string[],
    ticketSlug: string,
  ) => Promise<'create-new'>;
  requiresCollisionPrecheck: (flowType: Run['flowType']) => boolean;
  resolveRunDispatchRunnerModel: (
    run: Pick<Run, 'metrics'>,
    preview: { runner: string; model: string },
  ) => { runner: string; model: string };
  setRunFlags: (runId: string, flags: RunEngineFlags) => void;
}

/** Active-worker takeover is reserved for PR-bound follow-ups; other flows may replace only unowned warm slots. */
export function activeWorkerFreshReuseAllowed(flowType: Run['flowType']): boolean {
  return flowType === 'review-pr' || flowType === 'pr-complete' || flowType === 'update-branch';
}

/**
 * Selection-time slot claim. All claim-type writes must refuse a slot whose
 * phase is 'releasing' (an in-flight teardown owns it and will kill/reset
 * whatever lands there) and bump the ownership epoch so any teardown racing
 * this claim aborts its remaining writes instead of clobbering the claim.
 */

async function claimSelectedSlot(
  slotId: string,
  runId: string,
  generation: number,
  phase: 'preparing' | 'working',
  agent?: 'working',
  opts?: { takeoverLiveOwner?: boolean; reserveOnly?: boolean },
): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found while claiming slot: ${runId}`);
  if (run.nativeProfile) assertNativeProfileSlot(run.nativeProfile, await loadSlotVars(slotId));
  if (opts?.takeoverLiveOwner || opts?.reserveOnly) assertNativeSlotReplacementOwner(slotId, runId);
  let selectedExecutionTemplate:
    | import('@farmslot/protocol').ExecutionTemplateReference
    | undefined;
  const projectConfig = await loadProjectConfig(run.project);
  if (projectConfig?.executionTemplates) {
    const [projectVars, slotVars] = await Promise.all([
      loadProjectVars(run.project),
      loadSlotVars(slotId),
    ]);
    if (!projectUsesExecutionTemplateCatalog(projectVars)) {
      throw new Error(
        `Project "${run.project}" exposes execution-template capability but raw project configuration is missing execution_templates.`,
      );
    }
    if (!run.mode) {
      throw new Error('Configured execution-template selection requires an explicit run mode.');
    }
    const selected = resolveConfiguredExecutionTemplateForSlot(projectVars, {
      flow: run.flowType,
      platform: slotVars.platform,
      runMode: run.mode,
      ...(run.domain ? { explicitDomain: run.domain } : {}),
      ...(slotVars.domain ? { slotDomain: slotVars.domain } : {}),
      ...(run.executionTemplateId ? { explicitId: run.executionTemplateId } : {}),
    });
    selectedExecutionTemplate = selected.reference;
    if (
      run.executionTemplate &&
      (run.executionTemplate.id !== selected.reference.id ||
        run.executionTemplate.sourceId !== selected.reference.sourceId ||
        run.executionTemplate.sha256 !== selected.reference.sha256)
    ) {
      throw new Error(
        `Execution template changed before slot claim: expected ${run.executionTemplate.id} from ${run.executionTemplate.sourceId} at ${run.executionTemplate.sha256}, got ${selected.reference.id} from ${selected.reference.sourceId} at ${selected.reference.sha256}. Dispatch the run again.`,
      );
    }
  }

  if (!run.engineState?.flags?.skipPrepare)
    await releaseBranchHolderForSelection(slotId, run.branch);
  await commitSlotClaim(slotId, runId, generation, phase, agent, opts);
  if (selectedExecutionTemplate && !run.executionTemplate) {
    updateRun(runId, { executionTemplate: selectedExecutionTemplate });
  }
}

/**
 * The claim write itself, with its refusal named and a superseded attempt's
 * claim undone. Exported with its state writers injectable so the cancel
 * window can be driven with the write still pending.
 */
export async function commitSlotClaim(
  slotId: string,
  runId: string,
  generation: number,
  phase: 'preparing' | 'working',
  agent: 'working' | undefined,
  opts: { takeoverLiveOwner?: boolean; reserveOnly?: boolean } | undefined,
  deps: {
    claimSlotStatusIf?: typeof claimSlotStatusIf;
    resetSlotIf?: typeof resetSlotIf;
    transitionSlotStatus?: typeof transitionSlotStatus;
    readRow?: typeof readSlotRow;
    runLookup?: (id: string) => Pick<Run, 'status' | 'engineState'> | undefined;
    listSlotRuns?: () => Promise<SlotHistoryRun[]>;
  } = {},
): Promise<void> {
  const {
    claimSlotStatusIf: claimIf = claimSlotStatusIf,
    resetSlotIf: resetIf = resetSlotIf,
    transitionSlotStatus: transition = transitionSlotStatus,
    readRow = readSlotRow,
    runLookup = getRun,
    listSlotRuns = getAllRunsWithArchived,
  } = deps;
  const reservation = Boolean(opts?.takeoverLiveOwner || opts?.reserveOnly);
  // Ownership binds in the SAME claim write — EXCEPT for the nudge
  // takeover, which must leave current_run_id with the prior run:
  // nudgeDispatch's handoff re-reads the owner to terminalize it only
  // after delivery succeeds, and rebinding here would make it terminalize
  // the wrong (new) run while the prior worker keeps running.
  const fields: Record<string, unknown> = {
    lifecycle: 'busy',
    phase,
    // Takeover reserves the handoff instead of rebinding ownership. An
    // ordinary claim consumes the claimant's own reservation (fresh reuse
    // fences with one before teardown); a foreign one was refused above.
    ...(reservation ? { handoff_run_id: runId } : { current_run_id: runId, handoff_run_id: null }),
    ...(agent ? { agent } : {}),
  };
  // What the claim overwrote, read inside the same serialized write.
  let overwritten: Record<string, unknown> = {};
  // The owner a reservation was taken beside; the undo only restores beside it.
  let ownerBefore: unknown = null;
  const claim = await claimIf(
    slotId,
    (slot) => {
      if (!slotClaimAllowed(slot, runId, generation, runLookup, Boolean(opts?.takeoverLiveOwner)))
        return false;
      overwritten = Object.fromEntries(Object.keys(fields).map((key) => [key, slot[key] ?? null]));
      ownerBefore = slot.current_run_id ?? null;
      return true;
    },
    fields,
  );
  if (!claim.claimed) {
    if (runSupersededSince(runLookup(runId), generation)) throw runChangedError(runId, slotId);
    const row = await readRow(slotId);
    const blocker = row ? slotClaimBlocker(row, runId, runLookup) : null;
    throw slotClaimRefusedError(
      slotId,
      blocker
        ? await describeSlotClaimBlocker(slotId, blocker, listSlotRuns)
        : 'slot changed hands during the claim',
    );
  }
  // The predicate passed, but a cancel, pause or replay can still land while
  // the write is being renamed into place. That cleanup fenced the slot at the
  // pre-claim epoch, so it can no longer clear this claim: undo it here. Each
  // undo is fenced on the epoch this claim wrote (a later claim, even this
  // run's own replayed attempt, bumps it) and on the claim still standing.
  // - Ordinary claim: the run owns the slot, so reset it, keeping `warm`. A
  //   cancel teardown that already fenced it as releasing finishes its own
  //   release.
  // - Reservation (takeover or fresh reuse): the owner and its worker were
  //   never this run's, and nobody else will clear a busy row this run does
  //   not own. In one serialized write, each part on its own: drop this
  //   run's reservation if it still stands, whatever else changed (an owner
  //   that moved to ci-watch must not keep a dead reservation); and restore
  //   the busy/phase this claim wrote while the row still shows it beside the
  //   same owner, even when a native cancel already dropped the reservation.
  //   `agent` is restored only if it still holds the claimed value, so an
  //   owner's newer write (ci-watch, an agent-only completion) is kept.
  //   `warm` and `current_run_id` were never touched.
  if (runSupersededSince(runLookup(runId), generation)) {
    if (reservation) {
      await transition(slotId, (slot) => {
        if (slot.slot_epoch !== claim.epoch) return null;
        const undo: Record<string, unknown> = {};
        if (slot.handoff_run_id === runId) undo.handoff_run_id = null;
        if (
          (slot.current_run_id ?? null) === ownerBefore &&
          slot.lifecycle === 'busy' &&
          slot.phase === phase
        ) {
          undo.lifecycle = overwritten.lifecycle;
          undo.phase = overwritten.phase;
          if (agent && slot.agent === agent) undo.agent = overwritten.agent;
        }
        return Object.keys(undo).length > 0 ? { fields: undo } : null;
      });
    } else {
      await resetIf(
        slotId,
        (slot) =>
          slot.slot_epoch === claim.epoch &&
          slot.current_run_id === runId &&
          slot.phase !== SLOT_PHASE_RELEASING,
        Boolean((await readRow(slotId))?.warm),
      );
    }
    throw runChangedError(runId, slotId);
  }
}

/** How long an explicit slot pick waits for an in-flight release to land. */
export const EXPLICIT_SLOT_RELEASE_WAIT_MS = 5 * 60 * 1000;
const EXPLICIT_SLOT_RELEASE_POLL_MS = 2000;

function slotClaimRefusedError(slotId: string, holder: string): Error {
  return Object.assign(
    new Error(`Slot ${slotId} cannot be claimed: ${holder} — pick a slot again`),
    { code: SLOT_CLAIM_REFUSED_CODE },
  );
}

/** The attempt lost the run (cancel, pause, replay); it never owned the slot. */
function runChangedError(runId: string, slotId: string): Error {
  return Object.assign(
    new Error(`Run ${runId.slice(0, 8)} changed while waiting for slot ${slotId}`),
    { code: SLOT_CLAIM_REFUSED_CODE },
  );
}

/**
 * The find-slot claim CAS predicate, evaluated inside the serialized status
 * write. The run is re-read there as well: a cancel, pause or replay can land
 * after the step's last guard (pressure-ref persistence, the claim's write
 * queue), and a claim written for a superseded attempt leaves the slot busy
 * under a run that will never release it.
 *
 * Release, occupancy and a foreign handoff reservation block every claim — a
 * second takeover would otherwise deliver a second prompt into the same
 * worker and split-brain it. Exclusive by default: two selections racing over
 * one free snapshot must not both succeed. The takeover mode is the exception
 * — it deliberately claims over a live worker, either for an operator-approved
 * nudge (prior run terminalized by nudgeDispatch after delivery) or as the
 * fresh-reuse fence taken before the prior worker is destroyed.
 */
export function slotClaimAllowed(
  slot: Readonly<Record<string, unknown>>,
  runId: string,
  generation: number,
  runLookup: (id: string) => Pick<Run, 'status' | 'engineState'> | undefined,
  takeoverLiveOwner: boolean,
): boolean {
  if (runSupersededSince(runLookup(runId), generation)) return false;
  const blocker = slotClaimBlocker(slot, runId, runLookup);
  return blocker === null || (takeoverLiveOwner && blocker.kind === 'live-owner');
}

type SlotHistoryRun = Pick<
  Run,
  'id' | 'status' | 'slotId' | 'slotTeardownSkipped' | 'statusChangedAt' | 'steps'
>;

/**
 * The blocker as the operator needs it. An occupancy hold row keeps only its
 * reason; the run that left it recorded the same reason as
 * `slotTeardownSkipped`, so name that run (one that actually bound the slot,
 * not a run refused before claiming whose census saw the same occupant).
 */
async function describeSlotClaimBlocker(
  slotId: string,
  blocker: NonNullable<ReturnType<typeof slotClaimBlocker>>,
  listSlotRuns: () => Promise<SlotHistoryRun[]>,
): Promise<string> {
  if (blocker.kind !== 'occupied') return blocker.detail;
  const leftBy = (await listSlotRuns())
    .filter(
      (run) =>
        run.slotId === slotId &&
        run.slotTeardownSkipped === blocker.detail &&
        run.steps.some((step) => step.name === 'find-slot' && step.status === 'done'),
    )
    .sort((a, b) => (b.statusChangedAt ?? '').localeCompare(a.statusChangedAt ?? ''))[0];
  const since = leftBy
    ? ` since ${leftBy.statusChangedAt ?? 'an unknown time'}, left by run ${leftBy.id} (${leftBy.status})`
    : '';
  return `slot remains occupied${since}: ${blocker.detail}; release it with \`farmslot slot release ${slotId}\``;
}

/**
 * Preview an explicit slot pick once the slot can be claimed. Explicit picks
 * land right after the previous run on that slot ended, and its teardown runs
 * after the cancel returns. A release ends by itself, so wait for it
 * (bounded, as queue time); every other holder — a live run, a handoff, an
 * occupancy hold — only ends by an operator or by that run, so it fails at
 * once, named. A cancel, pause or replay while waiting owns the run: stop
 * without previewing or claiming. Scored picks (no slotId) preview directly.
 */
export async function previewWhenSlotClaimable<T>(
  runId: string,
  generation: number,
  slotId: string | undefined,
  preview: () => Promise<T>,
  deps: {
    readRow?: (slotId: string) => Promise<Readonly<Record<string, unknown>> | null>;
    runLookup?: (id: string) => Pick<Run, 'status' | 'engineState'> | undefined;
    listSlotRuns?: () => Promise<SlotHistoryRun[]>;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
    wrapWait?: <W>(wait: () => Promise<W>) => Promise<W>;
  } = {},
): Promise<T> {
  if (!slotId) return preview();
  const {
    readRow = readSlotRow,
    runLookup = getRun,
    listSlotRuns = getAllRunsWithArchived,
    now = Date.now,
    sleep = delay,
    timeoutMs = EXPLICIT_SLOT_RELEASE_WAIT_MS,
    wrapWait = (wait) => awaitAsQueueTime(runId, 'find-slot', wait),
  } = deps;
  const assertRunUnchanged = () => {
    if (runSupersededSince(runLookup(runId), generation)) throw runChangedError(runId, slotId);
  };
  const blockerOf = (row: Readonly<Record<string, unknown>> | null) =>
    row ? slotClaimBlocker(row, runId, runLookup) : null;
  const refuse = async (blocker: NonNullable<ReturnType<typeof slotClaimBlocker>>) =>
    slotClaimRefusedError(slotId, await describeSlotClaimBlocker(slotId, blocker, listSlotRuns));

  let blocker = blockerOf(await readRow(slotId));
  if (blocker?.kind === 'releasing') {
    // One read decides both whether to wait and whether it counts as queue time.
    blocker = await wrapWait(async () => {
      const deadline = now() + timeoutMs;
      let current = blocker;
      while (current?.kind === 'releasing') {
        if (now() >= deadline) {
          throw slotClaimRefusedError(
            slotId,
            `${current.detail}, still releasing after ${Math.round(timeoutMs / 60_000)}m`,
          );
        }
        await sleep(EXPLICIT_SLOT_RELEASE_POLL_MS);
        assertRunUnchanged();
        current = blockerOf(await readRow(slotId));
      }
      return current;
    });
  }
  if (blocker) throw await refuse(blocker);
  assertRunUnchanged();
  let result: T;
  try {
    result = await preview();
  } catch (error) {
    // A rival that claimed the slot after the release landed fails preview
    // with a generic "busy"/"working"; name the holder instead.
    const rival = blockerOf(await readRow(slotId));
    if (rival) throw await refuse(rival);
    throw error;
  }
  assertRunUnchanged();
  return result;
}

/**
 * Sustained-pressure gate for engine decision-path slot bindings (operator
 * "Use Selected Slot" picks and held-slot affinity reuse). These paths claim
 * a slot without going through dispatchPreview, so a generic human pick must
 * not bypass a pressure rejection: run the same explicit-slot admission with
 * the run's persisted override principal and reject stale/ref/mismatch
 * exactly like execution does, before any updateRun/claim/reset.
 */
async function assertEngineBoundSlotPressureAdmitted(
  runId: string,
  run: Pick<Run, 'pressureOverride' | 'pressureAdmissionRef'>,
  machine: string,
): Promise<void> {
  const storedOverride = run.pressureOverride;
  // Lightweight in-memory capture: pre-mutation guards always read CURRENT
  // ring/health state directly, never a settled snapshot cache, and never pay
  // resource resolution or tmux attribution.
  const decision = capturePressureAdmissionDecisionsLightweight(
    [machine],
    storedOverride
      ? {
          override: {
            machine: storedOverride.machine,
            pressureGeneration: storedOverride.pressureGeneration,
            reason: storedOverride.reason,
          },
          principalId: storedOverride.principalId,
        }
      : {},
  ).get(machine);
  const refreshedPreviewRef = refreshedAdmissionRefForAdmittedPreview(
    run.pressureAdmissionRef,
    decision,
  );
  if (refreshedPreviewRef) {
    console.warn(
      `[run-engine] pressure preview generation moved (${run.pressureAdmissionRef?.pressureGeneration} -> ${refreshedPreviewRef.pressureGeneration}) on ${refreshedPreviewRef.machine}; still admitted, launching`,
    );
    updateRun(runId, { pressureAdmissionRef: refreshedPreviewRef });
  }
  const outcome = resolveExecutePressureOutcome({
    machine,
    decision,
    storedOverride,
    admissionRef: getRun(runId)?.pressureAdmissionRef ?? run.pressureAdmissionRef,
  });
  if (outcome.rejection) throw new PressureAdmissionRejectedError(outcome.rejection);
  await consumeRunPressureAdmissionRef(runId, getRun(runId) ?? run);
}

/** Fresh preview identity when the same machine's generation rotated but it
 * is still admitted; otherwise null. A machine change is not a refresh. */
export function refreshedAdmissionRefForAdmittedPreview(
  clientAdmissionRef: Run['pressureAdmissionRef'],
  pressureAdmission:
    | {
        outcome: string;
        state?: string;
        machine: string;
        evidence: { generation: string | null };
      }
    | null
    | undefined,
): { machine: string; pressureGeneration: string } | null {
  if (!clientAdmissionRef) return null;
  if (pressureAdmission?.outcome !== 'admitted') return null;
  if (pressureAdmission.state === 'override' || pressureAdmission.state === 'disabled') {
    return null;
  }
  if (clientAdmissionRef.machine !== pressureAdmission.machine) return null;
  const generation = pressureAdmission.evidence.generation;
  if (!generation || clientAdmissionRef.pressureGeneration === generation) return null;
  return { machine: pressureAdmission.machine, pressureGeneration: generation };
}

/** Consume a validated client preview identity: audit-stamp `consumedAt` on
 * the persisted ref so a long PREPARE cannot fail green-to-green at the
 * execute recompute, while an unconsumed ref remains enforced there. */
async function consumeRunPressureAdmissionRef(
  runId: string,
  run: Pick<Run, 'pressureAdmissionRef'>,
): Promise<void> {
  const ref = run.pressureAdmissionRef;
  if (!ref || ref.consumedAt) return;
  const updated = updateRun(runId, {
    pressureAdmissionRef: consumedPressureAdmissionRef(ref),
  });
  await persistRunNow(updated, 'pressure-admission-ref-consumption');
}

/**
 * `generation` is the engine attempt running this step: a cancel, pause or
 * replay that moves the run off it owns the run, and no claim may land for it.
 */
export async function executeFindSlotStep(
  runId: string,
  run: Run,
  generation: number,
  context: FindSlotStepContext,
): Promise<StepIO> {
  if (canReconcileReviewQaRun(run)) {
    const project = await loadProjectConfig(run.project);
    const current = getRun(runId);
    if (
      !current ||
      (current.engineState?.generation ?? 0) !== generation ||
      !canReconcileReviewQaRun(current)
    )
      throw new Error('Run changed while resolving its Review/QA migration');
    run = current;
    try {
      const patch = reviewQaMigrationPatch(current, project?.qa, project?.workflowDefaults);
      if (patch) {
        run = updateRun(runId, patch);
        await persistRunNow(run, 'review-qa-migration');
        const persisted = getRun(runId);
        if (
          !persisted ||
          (persisted.engineState?.generation ?? 0) !== generation ||
          !canReconcileReviewQaRun(persisted)
        )
          throw new Error('Run changed while persisting its Review/QA migration');
        run = persisted;
      }
    } catch (error) {
      if (!(error instanceof ReviewQaConfigurationError)) throw error;
      throw new BlockedRunError(error.message, 'review-qa-needs-configuration');
    }
  }
  if (run.nativeProfile) {
    await inspectNativeWorkerProfile(run.nativeOwnerPrincipalId!, run.nativeProfile);
    const allowedSlots = await nativeProfileAllowedSlots(
      run.nativeProfile,
      run.allowedSlots ?? undefined,
    );
    if (run.slotId && !allowedSlots.includes(run.slotId))
      throw new Error('Selected slot does not belong to the native profile execution node');
    run = updateRun(runId, { allowedSlots });
    await persistRunNow(run, 'native profile slot eligibility');
  }
  const {
    broadcastFn,
    buildDispatchPreviewParamsForRun,
    createEngineDecision,
    determineSelectionMethodForRun,
    handleCollisionDecision,
    requiresCollisionPrecheck,
    resolveRunDispatchRunnerModel,
    setRunFlags,
  } = context;
  const inputs: Record<string, unknown> = {
    project: run.project,
    flowType: run.flowType,
    requestedSlotId: run.slotId || undefined,
  };
  // ADR-054: a slot whose detached HEAD is a park's preserved workspace is
  // dispatchable, so scoring must not charge it the stale-branch penalty. Any
  // other detached slot still scores stale — its commits are unaccounted for.
  const parkPreserved = parkPreservedSlotIds(getAllRuns());

  // Collision precheck — runs before slot allocation, grading, task-file
  // creation, or worker prep. The precheck itself reads the tasks dir
  // (cheap readdir) to detect collisions early so the operator can redirect
  // to a prior run before any expensive resource is claimed. The same
  // decision is replayed at WRITE_TASK (deduplicated by createEngineDecision,
  // unless the colliding dir set changed — see canReplayCollisionDecision).
  if (requiresCollisionPrecheck(run.flowType)) {
    const { existingDirs, ticketSlug } = await precheckTaskDirCollision(run);
    if (existingDirs.length > 0) {
      // Returns 'create-new' to fall through; other actions throw.
      await handleCollisionDecision(runId, run, existingDirs, ticketSlug);
    }
  }

  // For PR-bound flows the run branch is the PR head. Resolve profile fit before any
  // branch-affinity shortcut so wizard nudge/fresh-reuse paths honor simulator resources
  // the same way the normal slot picker does.
  const targetBranch =
    (run.flowType === 'review-pr' || run.flowType === 'pr-complete' || run.flowType === 'qa') &&
    run.branch
      ? run.branch
      : undefined;
  // Explicit prepare only — profile-fit suggestions never rewrite FIND_SLOT eligibility.
  const requiredPrepareProfile = run.prepareProfile || null;
  const releasableBranchHolderIds = await inspectReleasableBranchHolders(
    (await loadFleetStatus()).slots,
    run.project,
    targetBranch,
  );
  // A run that skips prepare keeps the slot's checkout, so slot repo blockers do not apply.
  const skipPrepare = Boolean(run.engineState?.flags?.skipPrepare);

  // CI-watch warm-session handoff: chained follow-up already pinned to the parent's
  // keep-warm slot. Bind immediately so DISPATCH can probe the live worker; do not
  // require busy/agent=working eligibility (slot is typically held/ci-watch, agent idle).
  if (run.engineState?.flags?.warmSessionReuse && run.slotId) {
    const warmSlot = (await loadFleetStatus()).slots.find((s) => s.slot === run.slotId);
    if (!warmSlot) {
      throw new Error(
        `Warm-session reuse slot '${run.slotId}' not found in fleet; cannot hand off chained run`,
      );
    }
    if (warmSlot.lifecycle === 'manual' || warmSlot.lifecycle === 'disabled') {
      throw new Error(
        `Warm-session reuse slot '${run.slotId}' is ${warmSlot.lifecycle}; cannot hand off`,
      );
    }
    const blocked = slotClaimBlockedByRelease(warmSlot);
    if (blocked) {
      throw new Error(
        `Warm-session reuse slot '${run.slotId}' ${blocked === 'releasing' ? 'is mid-release' : 'remains occupied'}`,
      );
    }
    // Warm reuse still delivers a NEW task into the session. The same admission
    // gate as every other binding; the kill switch is the deliberate bypass.
    await assertEngineBoundSlotPressureAdmitted(runId, run, warmSlot.machine);
    // Take over the parent's ownership fence; DISPATCH decides warm vs fresh after liveness.
    await claimSelectedSlot(run.slotId, runId, generation, 'working', 'working', {
      takeoverLiveOwner: true,
    });
    return {
      inputs,
      outputs: {
        selectedSlot: run.slotId,
        selectionMethod: 'warm-session-reuse',
        branch: warmSlot.branch ?? null,
        via: 'ci-watch-chain',
      },
    };
  }

  // Wizard-shortcut: when run.create was issued with `nudgeReuse: true` (operator picked
  // the busy branch-matched slot in the dispatch wizard), the slotId is already bound and
  // FIND_SLOT has no decision to make. Return immediately so DISPATCH can route through
  // nudgeDispatch — no fleet refresh, no candidate scoring, no card pop-up. Validation in
  // run.ts guarantees nudgeReuse + slotId travel together.
  //
  // TOCTOU protection: re-verify the slot is still nudge-eligible before short-circuiting.
  // The wizard click → run.create round-trip can take seconds; gateway restart recovery can
  // also rehydrate this branch with stale state. nudgeDispatch re-checks again at DISPATCH
  // time as belt-and-braces, but failing here gives the operator a usable error before any
  // pipeline state is mutated.
  if (run.engineState?.flags?.nudgeReuse && run.slotId) {
    const wizardSlot = (await loadFleetStatus()).slots.find((s) => s.slot === run.slotId);
    const allRuns = getAllRuns();
    const eligibilityFail = await verifyBranchAffinityNudgeStillEligible(
      wizardSlot,
      run.project,
      run.ticketOrPr,
      {
        familyId: run.familyId ?? null,
        lane: run.lane ?? null,
        variant: run.variant ?? null,
        allowedSlots: run.allowedSlots ?? null,
        // PR head branch the wizard resolved against pr.list — exact match wins regardless
        // of whether prHealth has been populated for the slot yet.
        targetBranch: targetBranch ?? null,
        requiredPrepareProfile,
        activeRunIds: activeRunIds(allRuns, runId),
      },
    );
    if (eligibilityFail) {
      throw new Error(
        `Branch-affinity nudge no longer valid: ${eligibilityFail}. Pick a slot again.`,
      );
    }
    // A nudge delivers a NEW task into the busy worker. It is gated like every
    // other binding for spec consistency; the kill switch is the bypass.
    if (wizardSlot) await assertEngineBoundSlotPressureAdmitted(runId, run, wizardSlot.machine);
    // Reserve the handoff exactly like the decision-card path: without this,
    // two wizard nudges racing the same worker would both deliver.
    await claimSelectedSlot(run.slotId, runId, generation, 'working', 'working', {
      takeoverLiveOwner: true,
    });
    return {
      inputs,
      outputs: {
        selectedSlot: run.slotId,
        selectionMethod: 'nudge',
        branch: wizardSlot?.branch ?? null,
        via: 'wizard',
      },
    };
  }

  // freshReuse wizard-shortcut: operator picked an active branch-matched worker or an
  // unowned warm slot. Re-verify that no other active Run took ownership between the
  // wizard click and run.create, then hard-kill the prior runner BEFORE PREPARE runs.
  // Without this teardown order, PREPARE's git reset / checkout / dependency install
  // would race the still-writing worker in the same worktree and corrupt slot state.
  // The standard fresh-dispatch pipeline (PREPARE → DISPATCH) takes over after the slot
  // is quiescent.
  if (run.engineState?.flags?.freshReuse && run.slotId) {
    const liveFleet = await loadFleetStatus();
    const wizardSlot = liveFleet.slots.find((s) => s.slot === run.slotId);
    const allRuns = getAllRuns();
    const otherActiveSlotIds = activeRunSlotIds(allRuns, runId);
    const replaceableWarm = Boolean(
      wizardSlot &&
      isReplaceableWarmSlot(wizardSlot, otherActiveSlotIds, activeRunIds(allRuns, runId)),
    );
    const becameFree = Boolean(
      wizardSlot && isFreeSlot(wizardSlot) && !otherActiveSlotIds.has(wizardSlot.slot),
    );
    let eligibilityFail: string | null = null;
    if (!wizardSlot) {
      eligibilityFail = `slot '${run.slotId}' is no longer in the fleet`;
    } else if (wizardSlot.project !== run.project) {
      eligibilityFail = `slot belongs to ${wizardSlot.project}, not ${run.project}`;
    } else if (run.allowedSlots?.length && !run.allowedSlots.includes(wizardSlot.slot)) {
      eligibilityFail = 'slot is outside the allowed slot list';
    } else if (replaceableWarm || becameFree) {
      eligibilityFail = validateSlotForDispatch(wizardSlot, liveFleet.slots, {
        targetBranch,
        releasableBranchHolderIds,
        requiredPrepareProfile,
        skipPrepare,
        allowWorking: replaceableWarm,
      });
    } else if (activeWorkerFreshReuseAllowed(run.flowType)) {
      eligibilityFail = await verifyBranchAffinityNudgeStillEligible(
        wizardSlot,
        run.project,
        run.ticketOrPr,
        {
          familyId: run.familyId ?? null,
          lane: run.lane ?? null,
          variant: run.variant ?? null,
          allowedSlots: run.allowedSlots ?? null,
          targetBranch: targetBranch ?? null,
          requiredPrepareProfile,
          activeRunIds: activeRunIds(allRuns, runId),
        },
      );
    } else {
      eligibilityFail = 'slot is busy and not eligible for warm replacement';
    }
    // The active-worker check above is the nudge gate, which never prepares. A
    // fresh dispatch does, so refuse a repo that cannot prepare BEFORE the
    // teardown below kills the worker.
    eligibilityFail ??= wizardSlot ? slotRepoBlocker(wizardSlot, { skipPrepare }) : null;
    if (eligibilityFail) {
      throw new Error(`Fresh-reuse no longer valid: ${eligibilityFail}. Pick a slot again.`);
    }
    // Fresh-reuse launches a NEW worker after killing the prior one. The
    // pressure gate must pass before any claim or destructive teardown.
    if (wizardSlot) await assertEngineBoundSlotPressureAdmitted(runId, run, wizardSlot.machine);
    // Atomic fence BEFORE destroying the prior worker: reserve the handoff in
    // the same CAS that refuses foreign reservations. A read-then-teardown
    // check would let a nudge reserve in the gap and have its in-flight
    // delivery killed here. The ordinary claim below consumes the fence.
    await claimSelectedSlot(run.slotId, runId, generation, 'preparing', undefined, {
      ...(replaceableWarm || becameFree ? { reserveOnly: true } : { takeoverLiveOwner: true }),
    });
    await prepareSlotForFreshReuse(run.slotId, runId);
    await claimSelectedSlot(run.slotId, runId, generation, 'preparing');
    broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
    return {
      inputs,
      outputs: {
        selectedSlot: run.slotId,
        selectionMethod: 'human-override',
        branch: wizardSlot?.branch ?? null,
        via: 'wizard-fresh-reuse',
      },
    };
  }

  // Capture candidate list before selection (live branch check for accurate scoring)
  const [fleet, projectConfigList] = await Promise.all([
    loadFleetStatus(true),
    loadProjectConfigs(),
  ]);
  const projectConfigs = projectConfigsFromProjects(projectConfigList);
  // `allowedSlots` narrows the project pool to the set the dispatch UI
  // filtered to at click time. Without this, FIND_SLOT could land the run
  // on a machine the user had just excluded via the global filter bar.
  const allowSet =
    run.allowedSlots && run.allowedSlots.length > 0 ? new Set(run.allowedSlots) : null;
  const projectSlots = fleet.slots.filter(
    (s) => s.project === run.project && (!allowSet || allowSet.has(s.slot)),
  );
  const freeSlots = projectSlots.filter(isFreeSlot);
  if (freeSlots.length > 0) await refreshBranches(freeSlots, { force: true });
  const isEligibleFreeSlot = (slot: (typeof freeSlots)[number]) =>
    !validateSlotForDispatch(slot, fleet.slots, {
      targetBranch,
      releasableBranchHolderIds,
      requiredPrepareProfile,
      skipPrepare,
    });
  const eligibleFreeSlots = freeSlots.filter(isEligibleFreeSlot);
  const candidates = freeSlots.slice(0, 10).map((s) => ({
    slotId: s.slot,
    score: isEligibleFreeSlot(s)
      ? slotScore(s, targetBranch, {
          familyId: run.familyId,
          projectConfigs,
          parkPreservedSlotIds: parkPreserved,
        })
      : -1,
    cdpLive: isCdpLive(s.health.cdp),
  }));

  // Affinity: for review-pr and pr-complete, prefer the held slot already on this branch
  if (!run.slotId && (run.flowType === 'review-pr' || run.flowType === 'pr-complete')) {
    const affinitySlot = findAffinitySlot(fleet.slots, run.project, run.ticketOrPr, {
      familyId: run.familyId,
      lane: run.lane,
      variant: run.variant ?? null,
      allowedSlots: run.allowedSlots ?? null,
    });
    if (
      affinitySlot &&
      !validateSlotForDispatch(affinitySlot, fleet.slots, {
        targetBranch,
        releasableBranchHolderIds,
        requiredPrepareProfile,
        skipPrepare,
      })
    ) {
      console.log(
        `[run-engine] ${run.flowType} affinity: reusing slot ${affinitySlot.slot} (branch=${affinitySlot.branch})`,
      );
      // Held-slot affinity reuse still launches a fresh worker on the machine.
      await assertEngineBoundSlotPressureAdmitted(runId, run, affinitySlot.machine);
      updateRun(runId, { slotId: affinitySlot.slot });
      await claimSelectedSlot(affinitySlot.slot, runId, generation, 'preparing');
      broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
      return {
        inputs,
        outputs: {
          selectedSlot: affinitySlot.slot,
          selectionMethod: 'affinity',
          branch: affinitySlot.branch,
          candidateCount: freeSlots.length,
          candidates,
        },
      };
    }

    // Headless branch-affinity nudge — entry points without a wizard (CI-watch chained
    // pr-complete after CI fail, CLI dispatch, gateway restart recovery) reach here. Look
    // for a busy slot already on this PR's branch; if found, surface a decision card so
    // the operator picks nudge / fresh / pick-different / abort. Wizard-driven runs
    // bypass this path because runCreate sets flags.nudgeReuse and FIND_SLOT short-circuits
    // at the top of the case. Production lane only — collect helper short-circuits on
    // comparison lane to preserve ADR-024 §7 scrub-between-siblings.
    if (run.lane !== 'comparison') {
      const busyMatching = selectBranchAffinityRefreshSlots(projectSlots);
      if (busyMatching.length > 0) await refreshBranches(busyMatching, { force: true });
      const nudgeCandidates = await collectBranchAffinityNudgeCandidates(
        fleet.slots,
        run.project,
        run.ticketOrPr,
        {
          familyId: run.familyId ?? null,
          lane: run.lane ?? null,
          variant: run.variant ?? null,
          allowedSlots: run.allowedSlots ?? null,
          // Same targetBranch the slotScore step uses — set when run.branch is the PR's
          // head branch, falsy on non-PR flows.
          targetBranch: targetBranch ?? null,
          requiredPrepareProfile,
          activeRunIds: activeRunIds(getAllRuns(), runId),
        },
      );
      if (nudgeCandidates.length > 0) {
        const top = nudgeCandidates[0];
        const prMatch = run.ticketOrPr.match(/#(\d+)$/);
        const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
        const desc = [
          `Slot **${top.slot.slot}** is already on **${top.slot.branch}** with an active ${top.slot.runner ?? 'worker'} session.`,
          top.ctxPct != null ? `Context: ${top.ctxPct}%.` : 'Context: unknown.',
          top.uncommittedCount > 0
            ? `WARNING: ${top.uncommittedCount} uncommitted file(s) — nudging will clobber nothing on disk but the worker may stomp them when it executes the new task.`
            : 'No uncommitted files.',
          top.riskFlags.length > 0 ? `Flags: ${top.riskFlags.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join('\n\n');

        const payload: import('@farmslot/protocol').BranchAffinityNudgePayload = {
          kind: 'branch_affinity_nudge',
          project: run.project,
          ticketOrPr: run.ticketOrPr,
          prNumber,
          candidate: {
            slotId: top.slot.slot,
            machine: top.slot.machine,
            branch: top.slot.branch,
            runner: top.slot.runner,
            model: top.slot.model,
            nudgeCount: top.nudgeCount,
            ctxPct: top.ctxPct,
            agentStatus: top.slot.agent,
            dispatchedAt: top.slot.dispatchedAt,
            currentRunId: top.slot.currentRunId ?? null,
            currentFlowType: top.slot.currentFlowType ?? null,
            uncommittedCount: top.uncommittedCount,
            uncommittedFiles: top.uncommittedFiles,
            prMatchKind: top.prMatchKind,
            canNudge: top.canNudge,
          },
          freeSlotCandidates: projectSlots.filter(isFreeSlot).map((s) => ({
            slotId: s.slot,
            score: isEligibleFreeSlot(s)
              ? slotScore(s, targetBranch, {
                  familyId: run.familyId,
                  projectConfigs,
                  parkPreservedSlotIds: parkPreserved,
                })
              : -1,
            branch: s.branch || '',
            lifecycle: s.lifecycle,
            health: s.health,
            machine: s.machine,
          })),
          riskFlags: top.riskFlags,
        };

        // Per-runner action gating: only emit the 'nudge' action when the slot's runner
        // supports tmux send-keys. For codex / opencode slots the row still surfaces (the
        // operator wants to see "this slot is on the PR's branch") but Fresh becomes the
        // primary action since Nudge would silently fail.
        const actions: Array<{
          id: string;
          label: string;
          style: 'primary' | 'secondary' | 'danger';
        }> = [];
        if (top.canNudge) {
          actions.push({
            id: 'nudge',
            label: 'Nudge worker (reuse session)',
            style: 'primary',
          });
          actions.push({ id: 'fresh', label: 'Kill & dispatch fresh', style: 'secondary' });
        } else {
          actions.push({ id: 'fresh', label: 'Kill & dispatch fresh', style: 'primary' });
        }
        actions.push({ id: 'pick', label: 'Pick different free slot', style: 'secondary' });
        actions.push({ id: 'abort', label: 'Abort', style: 'danger' });

        const actionId = await createEngineDecision(
          runId,
          'branch_affinity_nudge',
          desc,
          actions,
          payload,
        );

        if (actionId === 'abort') throw new Error('Aborted: branch-affinity nudge declined');
        if (actionId === 'nudge') {
          // Same nudge gating as the wizard shortcut above.
          await assertEngineBoundSlotPressureAdmitted(runId, run, top.slot.machine);
          setRunFlags(runId, { nudgeReuse: true, skipPrepare: true });
          updateRun(runId, { slotId: top.slot.slot });
          // Use phase='working', agent='working' (NOT the default agent='idle') because the
          // slot is being reassigned to a live, mid-task worker. The next DISPATCH step
          // routes through nudgeDispatch, whose preflight re-runs collectBranchAffinityNudgeCandidates
          // and requires `slot.agent === 'working'` — flipping to idle here would make every
          // decision-card nudge fail its own eligibility recheck. The wizard-shortcut path
          // doesn't markSlotBusy at all (slot already has agent=working from the prior run);
          // this branch needs the same preservation.
          await claimSelectedSlot(top.slot.slot, runId, generation, 'working', 'working', {
            takeoverLiveOwner: true,
          });
          broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
          return {
            inputs,
            outputs: {
              selectedSlot: top.slot.slot,
              selectionMethod: 'nudge',
              branch: top.slot.branch,
              candidateCount: freeSlots.length,
              candidates,
              via: 'decision-card',
            },
          };
        }
        if (actionId === 'fresh') {
          // Fresh dispatch prepares the slot: refuse a repo that cannot, before
          // the teardown below kills the worker.
          const repoBlocker = slotRepoBlocker(top.slot, { skipPrepare });
          if (repoBlocker) {
            throw new Error(`Kill & dispatch fresh refused on ${top.slot.slot}: ${repoBlocker}`);
          }
          // The decision-card 'fresh' branch binds the busy slot AND must hard-kill the
          // prior worker BEFORE PREPARE runs — otherwise PREPARE's git reset / checkout /
          // dependency install would race against a still-writing worker in the same
          // worktree and corrupt slot state. prepareSlotForFreshReuse handles
          // terminalize-prior-run + kill-worker-on-slot in the right order.
          // Fresh dispatch on the slot: pressure gate before claim/teardown.
          await assertEngineBoundSlotPressureAdmitted(runId, run, top.slot.machine);
          // Atomic fence BEFORE destroying the prior worker — same rationale
          // as the freshReuse wizard-shortcut above.
          await claimSelectedSlot(top.slot.slot, runId, generation, 'preparing', undefined, {
            takeoverLiveOwner: true,
          });
          // Bind the slot BEFORE the destructive teardown: if preparation
          // throws, failure cleanup locates the slot via run.slotId and can
          // clear the reservation the fence just wrote.
          updateRun(runId, { slotId: top.slot.slot });
          await prepareSlotForFreshReuse(top.slot.slot, runId);
          await claimSelectedSlot(top.slot.slot, runId, generation, 'preparing');
          broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
          return {
            inputs,
            outputs: {
              selectedSlot: top.slot.slot,
              selectionMethod: 'human-override',
              branch: top.slot.branch,
              candidateCount: freeSlots.length,
              candidates,
            },
          };
        }
        // 'pick' — the decision card lets the operator pick a specific free slot inline
        // (selectionData.slotId), or decline by leaving it empty. With an explicit slot,
        // bind it directly with selectionMethod=human-override; without one, fall through
        // to the existing slot-picker / scoring flow below so the engine still dispatches
        // without re-asking.
        if (actionId === 'pick') {
          const resolvedDecision = getRun(runId)!.decisions.find(
            (d) => d.type === 'engine_branch_affinity_nudge' && d.resolvedAt,
          );
          const pickedSlotId =
            (resolvedDecision?.selectionData?.slotId as string | undefined) ?? null;
          if (pickedSlotId) {
            // selectionData is operator-supplied and unconstrained: now that
            // claims create missing status rows, a typo'd or forged slot id
            // would allocate a ghost row — and a ghost/disabled/foreign-
            // project row must not be claimable either. Re-probe the fleet so
            // the check sees live lifecycle/branch state, then run the full
            // dispatch validation (branch ownership, companion resources).
            const freshFleet = await loadFleetStatus(true);
            const picked = freshFleet.slots.find((s) => s.slot === pickedSlotId);
            const ineligible = pickedSlotIneligibility(picked, run.project);
            if (ineligible || !picked) {
              throw new Error(
                `Picked slot '${pickedSlotId}' is not eligible (${ineligible ?? 'not in the fleet'}); pick a slot again`,
              );
            }
            if (allowSet && !allowSet.has(pickedSlotId)) {
              throw new Error(
                `Picked slot '${pickedSlotId}' is not in the allowed slot list; pick a slot again`,
              );
            }
            const err = validateSlotForDispatch(picked, freshFleet.slots, {
              targetBranch,
              releasableBranchHolderIds,
              requiredPrepareProfile,
              skipPrepare,
            });
            if (err) throw new Error(`Selected slot ${pickedSlotId}: ${err}`);
            // A human pick is not a pressure override. The same admission gate
            // as every other fresh binding, before updateRun/claim.
            await assertEngineBoundSlotPressureAdmitted(runId, run, picked.machine);
            updateRun(runId, { slotId: pickedSlotId });
            await claimSelectedSlot(pickedSlotId, runId, generation, 'preparing');
            broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
            return {
              inputs,
              outputs: {
                selectedSlot: pickedSlotId,
                selectionMethod: 'human-override',
                candidateCount: freeSlots.length,
                candidates,
              },
            };
          }
        }
      }
    }
  }

  // Human intervention when no good candidates exist
  if (
    !run.slotId &&
    (eligibleFreeSlots.length === 0 ||
      eligibleFreeSlots.every((s) =>
        isDispatchScoreStale(
          slotScore(s, targetBranch, {
            familyId: run.familyId,
            projectConfigs,
            parkPreservedSlotIds: parkPreserved,
          }),
        ),
      ))
  ) {
    const freeSlotsMissingCompanionResource =
      freeSlots.length > 0 &&
      prepareProfileNeedsCompanionResource(requiredPrepareProfile) &&
      freeSlots.every((s) => companionResourceBlocker(s, requiredPrepareProfile));
    const reason =
      freeSlots.length === 0
        ? 'no_free_slots'
        : eligibleFreeSlots.length === 0 && freeSlotsMissingCompanionResource
          ? 'missing_required_resources'
          : 'all_stale';
    const allProjectSlots = projectSlots.map((s) => ({
      slotId: s.slot,
      score:
        isFreeSlot(s) && isEligibleFreeSlot(s)
          ? slotScore(s, targetBranch, {
              familyId: run.familyId,
              projectConfigs,
              parkPreservedSlotIds: parkPreserved,
            })
          : reason === 'missing_required_resources' &&
              !companionResourceBlocker(s, requiredPrepareProfile)
            ? slotScore(s, targetBranch, {
                familyId: run.familyId,
                projectConfigs,
                parkPreservedSlotIds: parkPreserved,
              })
            : -1,
      branch: s.branch || '',
      lifecycle: s.lifecycle,
      health: s.health,
      machine: s.machine,
    }));

    const desc =
      reason === 'no_free_slots'
        ? `No free slots for **${run.project}**. ${projectSlots.length} slots exist but all are busy or disabled.`
        : reason === 'missing_required_resources'
          ? `No free slots for **${run.project}** have the isolated simulator resources required by **${requiredPrepareProfile}**. Wait until a listed iOS or Android resource slot is ready, then pick it.`
          : `All ${freeSlots.length} free slot(s) have stale branches (score >= ${SLOT_STALE_BRANCH_SCORE_PENALTY}). Pick one to reset or use as-is.`;

    const slotPickerPayload: import('@farmslot/protocol').SlotPickerPayload = {
      kind: 'slot_picker',
      project: run.project,
      candidates: allProjectSlots,
      reason,
    };

    // The run waits here until a slot frees up or the operator picks one.
    const actionId = await awaitAsQueueTime(runId, 'find-slot', () =>
      createEngineDecision(
        runId,
        'no_suitable_slot',
        desc,
        [
          { id: 'pick', label: 'Use Selected Slot', style: 'primary' },
          { id: 'abort', label: 'Abort Run', style: 'danger' },
        ],
        slotPickerPayload,
      ),
    );

    if (actionId === 'abort') throw new Error('Aborted: no suitable slot');

    // User picked a slot via selectionData
    const resolvedDecision = getRun(runId)!.decisions.find(
      (d) => d.type === 'engine_no_suitable_slot' && d.resolvedAt,
    );
    const pickedSlotId = (resolvedDecision?.selectionData?.slotId as string) || null;
    if (!pickedSlotId) throw new Error('No slot selected');
    // Same unconstrained-selectionData exposure as the decision-card 'pick'
    // branch above: the picked id must be an eligible live pool member, and it
    // must pass full dispatch validation against a fresh fleet probe.
    {
      const freshFleet = await loadFleetStatus(true);
      const picked = freshFleet.slots.find((s) => s.slot === pickedSlotId);
      const ineligible = pickedSlotIneligibility(picked, run.project);
      if (ineligible || !picked) {
        throw new Error(
          `Picked slot '${pickedSlotId}' is not eligible (${ineligible ?? 'not in the fleet'}); pick a slot again`,
        );
      }
      if (allowSet && !allowSet.has(pickedSlotId)) {
        throw new Error(
          `Picked slot '${pickedSlotId}' is not in the allowed slot list; pick a slot again`,
        );
      }
      const pickedSlotError = validateSlotForDispatch(picked, freshFleet.slots, {
        targetBranch,
        releasableBranchHolderIds,
        requiredPrepareProfile,
        skipPrepare,
      });
      if (pickedSlotError) throw new Error(`Selected slot ${pickedSlotId}: ${pickedSlotError}`);
      // "Use Selected Slot" is not a pressure override. The same admission gate
      // as every other fresh binding, before updateRun/claim/reset.
      await assertEngineBoundSlotPressureAdmitted(runId, run, picked.machine);
    }

    // Claim BEFORE any destructive reset: the claim CAS refuses live-owned,
    // reserved, and mid-release slots and THROWS, so forged or stale
    // selectionData with resetBranch can never hard-reset a repo an active
    // owner's worker is still writing in — and the claim's 'preparing' fence
    // keeps rivals out for the duration of the reset below.
    updateRun(runId, { slotId: pickedSlotId });
    await claimSelectedSlot(pickedSlotId, runId, generation, 'preparing');

    // If user requested reset, do it behind the claim fence
    if (resolvedDecision?.selectionData?.resetBranch) {
      const vars = await loadSlotVars(pickedSlotId);
      // Entry guard mirroring the other destructive-op call sites — never reset
      // the gateway's own operator root (resetSlotRepoToIdle also backstops this).
      await assertSlotNotOperatorRoot(vars, SLOT_DESTRUCTIVE_OPS.idleReset);
      let projectVars;
      let projectJson = {};
      try {
        projectVars = await loadProjectVars(vars.projectName);
        projectJson = projectVars.projectJson;
      } catch {
        /* no project config */
      }
      const defaultBranch = getProjectField(projectJson, 'default_branch') || DEFAULT_BRANCH;
      const idleReset = await resetSlotRepoToIdle(vars, projectJson, projectVars, defaultBranch);
      console.log(
        `[run-engine] reset ${pickedSlotId}: ${slotIdleResetStepDetail(idleReset, defaultBranch)}`,
      );
    }

    broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
    return {
      inputs,
      outputs: {
        selectedSlot: pickedSlotId,
        selectionMethod: 'human-override',
        candidateCount: freeSlots.length,
        candidates,
        resetBranch: !!resolvedDecision?.selectionData?.resetBranch,
      },
    };
  }

  const result = await previewWhenSlotClaimable(runId, generation, run.slotId || undefined, () =>
    dispatchPreview(
      {
        ...buildDispatchPreviewParamsForRun(run),
        ...(run.qa ? { qaProfileId: run.qa.profile.id, qaInputs: run.qa.inputs } : {}),
        ...(skipPrepare ? { skipPrepare } : {}),
      },
      // Delayed engine preview: the audit principal was resolved and persisted
      // at run.create; never re-derive it from ambient context here.
      {
        ...(run.pressureOverride ? { overridePrincipalId: run.pressureOverride.principalId } : {}),
        includeProfileFit: false,
      },
    ),
  );
  // Automatic selection already excluded pressure-rejected machines; a
  // rejection here means an explicit slot (or a pinned affinity slot) sits on
  // a rejected machine and no valid current override was supplied. Fail the
  // run with the backend decision. Never launch on rejected evidence.
  if (result.pressureAdmission?.outcome === 'rejected') {
    throw new PressureAdmissionRejectedError(result.pressureAdmission);
  }
  // Same-machine generation can rotate while still admitted; refresh the
  // stored identity. A machine change is still PRESSURE_PREVIEW_STALE.
  // DISPATCH still rejects an unconsumed stale ref when FIND_SLOT was skipped.
  const clientAdmissionRef = run.pressureAdmissionRef;
  const refreshedPreviewRef = refreshedAdmissionRefForAdmittedPreview(
    clientAdmissionRef,
    result.pressureAdmission,
  );
  if (refreshedPreviewRef) {
    console.warn(
      `[run-engine] pressure preview generation moved (${clientAdmissionRef?.pressureGeneration} -> ${refreshedPreviewRef.pressureGeneration}) on ${refreshedPreviewRef.machine}; still admitted, launching`,
    );
    updateRun(runId, { pressureAdmissionRef: refreshedPreviewRef });
  } else if (
    clientAdmissionRef &&
    result.pressureAdmission?.outcome === 'admitted' &&
    result.pressureAdmission.state !== 'override' &&
    result.pressureAdmission.state !== 'disabled' &&
    (clientAdmissionRef.machine !== result.pressureAdmission.machine ||
      clientAdmissionRef.pressureGeneration !== result.pressureAdmission.evidence.generation)
  ) {
    throw new PressureAdmissionRejectedError({
      outcome: 'rejected',
      machine: result.pressureAdmission.machine,
      state: 'stale',
      code: 'PRESSURE_PREVIEW_STALE',
      reason: `Dispatch was previewed against pressure generation ${clientAdmissionRef.pressureGeneration} on ${clientAdmissionRef.machine}, but ${result.pressureAdmission.machine} is now at ${result.pressureAdmission.evidence.generation ?? 'none'}; refresh the preview and dispatch against the fresh decision.`,
      causes: [],
      evidence: result.pressureAdmission.evidence,
      overridable: false,
    });
  }
  // Common scored/explicit path: the validated client preview identity is
  // consumed HERE, before the slot bind/claim, so a long PREPARE cannot turn
  // a green-to-green generation move into a launch-time failure.
  await consumeRunPressureAdmissionRef(runId, getRun(runId) ?? run);
  const slotId = result.preview.slotId;
  if (!slotId) throw new Error('Workspace review must use its workspace allocation path');
  updateRun(runId, { slotId });
  // Mark slot as claimed by this run
  await claimSelectedSlot(slotId, runId, generation, 'preparing');
  // Stamp the slot's persistent runner/model fields now so the UI's slot
  // card surfaces the upcoming worker as soon as the bind happens.
  // Without this, the slot retains the previous run's runner/model until
  // DISPATCH (buildSlotClaimStatus, methods/dispatch.ts) overwrites them
  // — so operators see e.g. "cursor/cursor-grok-4.6-high-fast" while a claude/opus run
  // is preparing on the slot. dispatchExecute will overwrite with its
  // final resolved values once the worker launches.
  const previewRunner = result.preview.runner;
  const previewModel = result.preview.model;
  if (previewRunner || previewModel) {
    await updateSlotStatus(slotId, {
      ...(previewRunner ? { runner: previewRunner } : {}),
      ...(previewModel && previewModel !== 'unknown' ? { model: previewModel } : {}),
    });
  }
  broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });

  // Determine selection method (use inputs.requestedSlotId, not run.slotId which was mutated by updateRun)
  const selectionMethod = determineSelectionMethodForRun(
    run,
    inputs.requestedSlotId as string | undefined,
    projectSlots,
    slotId,
  );

  // User's model/runner selection takes priority over slot/project defaults.
  // If the operator picked a runner but left model unset/unknown, resolve
  // through that runner's registry default instead of borrowing the slot's
  // runner/model (for Cursor this must be the Cursor default, not Claude's opus).
  //
  // Aside on grade.modelRecommendation: the dispatch wizard sends a default
  // `model` on every run.create (the displayed pill value), so by the time
  // we reach here metrics.model is already populated and `gradeTicket`'s
  // `if (!current.metrics.model)` guard at the GRADE step is a no-op in
  // practice — this predates the FIND_SLOT/GRADE reorder. Surfacing
  // grade.modelRecommendation in the UI without overriding an operator's
  // explicit pin needs a separate "model touched" track on the wizard +
  // run record; that's deferred outside this PR's collision-UX scope.
  const { runner: resolvedRunner, model: resolvedModel } = resolveRunDispatchRunnerModel(
    run,
    result.preview,
  );
  const metricsUpdate = {
    ...getRun(runId)!.metrics,
    runner: resolvedRunner,
    model: resolvedModel,
  };
  // If the run was created without an explicit runner or tier, safetyTier
  // is still undefined — pin it to the resolved runner's default now so
  // dispatch and chained runs see a concrete posture.
  const tierUpdate =
    run.safetyTier === undefined ? { safetyTier: runnerDefaultSafetyTier(resolvedRunner) } : {};
  updateRun(runId, { metrics: metricsUpdate, ...tierUpdate });

  return {
    inputs,
    outputs: {
      selectedSlot: slotId,
      runner: resolvedRunner,
      model: resolvedModel,
      selectionMethod,
      candidateCount: freeSlots.length,
      candidates,
    },
  };
}
