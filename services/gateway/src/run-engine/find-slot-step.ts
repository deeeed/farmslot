import {
  type DecisionAction,
  DEFAULT_BRANCH,
  type DispatchPreviewParams,
  Events,
  isDispatchScoreStale,
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
  activeRunIds,
  activeRunSlotIds,
  companionResourceBlocker,
  isCdpLive,
  isFreeSlot,
  isReplaceableWarmSlot,
  pickedSlotIneligibility,
  prepareProfileNeedsCompanionResource,
  projectConfigsFromProjects,
  SLOT_CLAIM_REFUSED_CODE,
  slotClaimBlockedByHandoff,
  slotClaimBlockedByLiveOwner,
  slotClaimBlockedByRelease,
  slotScore,
  validateSlotForDispatch,
} from '../methods/dispatch/slot-scoring.js';
import {
  assertSlotNotOperatorRoot,
  resetSlotRepoToIdle,
  slotIdleResetStepDetail,
} from '../methods/slot/slot-tracking.js';
import { runnerDefaultSafetyTier } from '../runners/registry.js';
import { getAllRuns, getRun, persistRunNow, updateRun } from '../runs/store.js';
import {
  projectUsesExecutionTemplateCatalog,
  resolveConfiguredExecutionTemplateForSlot,
} from '../tasks/execution-template-catalog.js';
import { precheckTaskDirCollision } from '../tasks/writer.js';

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
  phase: 'preparing' | 'working',
  agent?: 'working',
  opts?: { takeoverLiveOwner?: boolean; reserveOnly?: boolean },
): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found while claiming slot: ${runId}`);
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

  const claim = await claimSlotStatusIf(
    slotId,
    (slot) => {
      if (slotClaimBlockedByRelease(slot) !== null) return false;
      // A foreign handoff reservation blocks every claim — including a second
      // takeover, which would otherwise deliver a second prompt into the same
      // worker and split-brain it.
      if (slotClaimBlockedByHandoff(slot, runId) !== null) return false;
      // Exclusive by default: two selections racing over one free snapshot
      // must not both succeed. The takeover mode is the exception — it
      // deliberately claims over a live worker, either for an
      // operator-approved nudge (prior run terminalized by nudgeDispatch
      // after delivery) or as the fresh-reuse fence taken before the prior
      // worker is destroyed.
      if (opts?.takeoverLiveOwner) return true;
      return slotClaimBlockedByLiveOwner(slot, runId, getRun) === null;
    },
    // Ownership binds in the SAME claim write — EXCEPT for the nudge
    // takeover, which must leave current_run_id with the prior run:
    // nudgeDispatch's handoff re-reads the owner to terminalize it only
    // after delivery succeeds, and rebinding here would make it terminalize
    // the wrong (new) run while the prior worker keeps running.
    {
      lifecycle: 'busy',
      phase,
      // Takeover reserves the handoff instead of rebinding ownership. An
      // ordinary claim consumes the claimant's own reservation (fresh reuse
      // fences with one before teardown); a foreign one was refused above.
      ...(opts?.takeoverLiveOwner || opts?.reserveOnly
        ? { handoff_run_id: runId }
        : { current_run_id: runId, handoff_run_id: null }),
      ...(agent ? { agent } : {}),
    },
  );
  if (!claim.claimed) {
    throw Object.assign(
      new Error(
        `Slot ${slotId} is mid-release or claimed by another live run; selection cannot claim it — pick a slot again`,
      ),
      { code: SLOT_CLAIM_REFUSED_CODE },
    );
  }
  if (selectedExecutionTemplate && !run.executionTemplate) {
    updateRun(runId, { executionTemplate: selectedExecutionTemplate });
  }
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

export async function executeFindSlotStep(
  runId: string,
  run: Run,
  context: FindSlotStepContext,
): Promise<StepIO> {
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
    (run.flowType === 'review-pr' || run.flowType === 'pr-complete') && run.branch
      ? run.branch
      : undefined;
  // Explicit prepare only — profile-fit suggestions never rewrite FIND_SLOT eligibility.
  const requiredPrepareProfile = run.prepareProfile || null;

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
    // Warm reuse still delivers a NEW task into the session. The same admission
    // gate as every other binding; the kill switch is the deliberate bypass.
    await assertEngineBoundSlotPressureAdmitted(runId, run, warmSlot.machine);
    // Take over the parent's ownership fence; DISPATCH decides warm vs fresh after liveness.
    await claimSelectedSlot(run.slotId, runId, 'working', 'working', { takeoverLiveOwner: true });
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
    await claimSelectedSlot(run.slotId, runId, 'working', 'working', { takeoverLiveOwner: true });
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
        requiredPrepareProfile,
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
    await claimSelectedSlot(run.slotId, runId, 'preparing', undefined, {
      ...(replaceableWarm || becameFree ? { reserveOnly: true } : { takeoverLiveOwner: true }),
    });
    await prepareSlotForFreshReuse(run.slotId, runId);
    await claimSelectedSlot(run.slotId, runId, 'preparing');
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
      requiredPrepareProfile,
    });
  const eligibleFreeSlots = freeSlots.filter(isEligibleFreeSlot);
  const candidates = freeSlots.slice(0, 10).map((s) => ({
    slotId: s.slot,
    score: isEligibleFreeSlot(s)
      ? slotScore(s, targetBranch, { familyId: run.familyId, projectConfigs })
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
        requiredPrepareProfile,
      })
    ) {
      console.log(
        `[run-engine] ${run.flowType} affinity: reusing slot ${affinitySlot.slot} (branch=${affinitySlot.branch})`,
      );
      // Held-slot affinity reuse still launches a fresh worker on the machine.
      await assertEngineBoundSlotPressureAdmitted(runId, run, affinitySlot.machine);
      updateRun(runId, { slotId: affinitySlot.slot });
      await claimSelectedSlot(affinitySlot.slot, runId, 'preparing');
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
              ? slotScore(s, targetBranch, { familyId: run.familyId, projectConfigs })
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
          await claimSelectedSlot(top.slot.slot, runId, 'working', 'working', {
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
          // The decision-card 'fresh' branch binds the busy slot AND must hard-kill the
          // prior worker BEFORE PREPARE runs — otherwise PREPARE's git reset / checkout /
          // dependency install would race against a still-writing worker in the same
          // worktree and corrupt slot state. prepareSlotForFreshReuse handles
          // terminalize-prior-run + kill-worker-on-slot in the right order.
          // Fresh dispatch on the slot: pressure gate before claim/teardown.
          await assertEngineBoundSlotPressureAdmitted(runId, run, top.slot.machine);
          // Atomic fence BEFORE destroying the prior worker — same rationale
          // as the freshReuse wizard-shortcut above.
          await claimSelectedSlot(top.slot.slot, runId, 'preparing', undefined, {
            takeoverLiveOwner: true,
          });
          // Bind the slot BEFORE the destructive teardown: if preparation
          // throws, failure cleanup locates the slot via run.slotId and can
          // clear the reservation the fence just wrote.
          updateRun(runId, { slotId: top.slot.slot });
          await prepareSlotForFreshReuse(top.slot.slot, runId);
          await claimSelectedSlot(top.slot.slot, runId, 'preparing');
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
              requiredPrepareProfile,
            });
            if (err) throw new Error(`Selected slot ${pickedSlotId}: ${err}`);
            // A human pick is not a pressure override. The same admission gate
            // as every other fresh binding, before updateRun/claim.
            await assertEngineBoundSlotPressureAdmitted(runId, run, picked.machine);
            updateRun(runId, { slotId: pickedSlotId });
            await claimSelectedSlot(pickedSlotId, runId, 'preparing');
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
          slotScore(s, targetBranch, { familyId: run.familyId, projectConfigs }),
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
          ? slotScore(s, targetBranch, { familyId: run.familyId, projectConfigs })
          : reason === 'missing_required_resources' &&
              !companionResourceBlocker(s, requiredPrepareProfile)
            ? slotScore(s, targetBranch, { familyId: run.familyId, projectConfigs })
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

    const actionId = await createEngineDecision(
      runId,
      'no_suitable_slot',
      desc,
      [
        { id: 'pick', label: 'Use Selected Slot', style: 'primary' },
        { id: 'abort', label: 'Abort Run', style: 'danger' },
      ],
      slotPickerPayload,
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
        requiredPrepareProfile,
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
    await claimSelectedSlot(pickedSlotId, runId, 'preparing');

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

  const result = await dispatchPreview(
    buildDispatchPreviewParamsForRun(run),
    // Delayed engine preview: the audit principal was resolved and persisted
    // at run.create; never re-derive it from ambient context here.
    run.pressureOverride ? { overridePrincipalId: run.pressureOverride.principalId } : {},
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
  updateRun(runId, { slotId });
  // Mark slot as claimed by this run
  await claimSelectedSlot(slotId, runId, 'preparing');
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
