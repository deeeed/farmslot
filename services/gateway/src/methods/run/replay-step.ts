import { randomUUID } from 'node:crypto';

import {
  DEFAULT_TASK_DIR,
  Events,
  FLOW_STEPS,
  type FlowType,
  isInteractiveDevRun,
  isTerminalRunStatus,
  PipelineSteps as PS,
  PR_BOUND_FLOW_TYPES,
  type QueueClaim,
  resolveRunSlotId,
  type RunEngineState,
  type RunReplayStepParams,
  type RunReplayStepResult,
  type RunStatus,
} from '@farmslot/protocol';

import {
  claimQueueItemForReplay,
  getQueueSnapshot,
  persistQueueNow,
  releaseQueueClaim,
  removeQueueItemInternal,
  renewQueueClaim,
} from '../../backlog/dispatch-queue.js';
import { execOnSlot } from '../../core/exec.js';
import { SLOT_PHASE_RELEASING } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { isFollowUpFlow } from '../../family-observability/context.js';
import {
  hasValidPrNumber,
  supersedeStaleHumanGateDecisions,
} from '../../run-engine/gate-policy.js';
import {
  bumpRunGeneration,
  cancelRunEngine,
  setRunFlags,
  startRun,
} from '../../run-engine/orchestrator.js';
import { getAllRuns, getRun, persistRunNow, updateRun, updateRunStep } from '../../runs/store.js';
import { validateTicketRef } from '../dispatch/ticket-ref.js';

import {
  isInternalArtifactOnlyEvalTicket,
  isLocalDevRef,
  isStoredManualBacklogRun,
} from './ticket-policy.js';

type Emit = (event: string, payload: unknown) => void;

const REPLAY_STEP_TO_ACTIVE_STATUS: Partial<Record<string, RunStatus>> = {
  [PS.GRADE]: 'grading',
  [PS.WRITE_TASK]: 'writing-task',
  [PS.FIND_SLOT]: 'slot-finding',
  [PS.PREPARE]: 'preparing',
  [PS.DISPATCH]: 'dispatching',
  [PS.MONITOR]: 'monitoring',
  [PS.SELF_REVIEW]: 'self-reviewing',
  [PS.HUMAN_GATE]: 'human-gating',
  [PS.FINALIZE]: 'completing',
  [PS.COMPLETE]: 'completing',
  [PS.CI_WATCH]: 'ci-watching',
};

function activeStatusForReplayStep(stepName: string): RunStatus {
  return REPLAY_STEP_TO_ACTIVE_STATUS[stepName] ?? 'created';
}

// Which queue row, if any, replaced this run when it was cancelled?
//
// Graph and node identity alone is not enough to answer that. Launch-plan
// comparison rows are deliberately built with the baseline's workGraphId and
// workNodeId, so a graph/node match can select a sibling candidate's work.
// Removing that row would delete required comparison work, and the candidate
// projection keeps the dead queue id so it never rematerializes.
//
// Candidate ids are scoped to their plan — see `launchCandidateKey`, which keys
// on [backlogItemId, launchPlanId, candidateId]. A replacement plan may reuse a
// candidate id, so the plan must match too, or replaying a run from a superseded
// plan would delete the current plan's work. Plain runs have none of these on
// either side.
function isReplacementFor(
  item: {
    workGraphId?: string;
    workNodeId?: string;
    launchPlanId?: string;
    launchCandidateId?: string;
  },
  run: NonNullable<ReturnType<typeof getRun>>,
): boolean {
  return (
    item.workGraphId === run.workGraphId &&
    item.workNodeId === run.workNodeId &&
    item.launchPlanId === run.launchPlanId &&
    item.launchCandidateId === run.launchCandidateId
  );
}

/**
 * Refuse cancelled-run reclaim when another live Run already owns the node
 * (queue row may already be gone after handoff) or the replacement row has a
 * stamped live runId. Must run before any replay mutation.
 */
function assertCancelledReplayNodeAvailable(
  existing: NonNullable<ReturnType<typeof getRun>>,
  runId: string,
): void {
  const liveOwner = getAllRuns().find(
    (run) =>
      run.id !== runId &&
      !isTerminalRunStatus(run.status) &&
      isReplacementFor(
        {
          workGraphId: run.workGraphId,
          workNodeId: run.workNodeId,
          launchPlanId: run.launchPlanId,
          launchCandidateId: run.launchCandidateId,
        },
        existing,
      ),
  );
  if (liveOwner) {
    throw new Error(
      `Run ${runId.slice(0, 8)} could not be replayed: its node is already owned by ` +
        `live run ${liveOwner.id.slice(0, 8)}. The cancelled run is left cancelled. ` +
        'Next: follow the live run for this node.',
    );
  }
  const replacement = getQueueSnapshot().find((item) => isReplacementFor(item, existing));
  if (replacement?.runId) {
    const handedOff = getRun(replacement.runId);
    if (handedOff && !isTerminalRunStatus(handedOff.status)) {
      throw new Error(
        `Run ${runId.slice(0, 8)} could not be replayed: its node was redispatched ` +
          `to run ${replacement.runId.slice(0, 8)} (queue item ${replacement.id.slice(0, 8)}). ` +
          'The cancelled run is left cancelled. Next: follow the new run for this node.',
      );
    }
  }
}

function resetPublishGateApprovalForReplay(
  engineState: RunEngineState | undefined,
): RunEngineState | undefined {
  if (!engineState?.publishGate) return engineState;
  const {
    approvedAt: _approvedAt,
    approvedPackageHash: _approvedPackageHash,
    ...publishGateWithoutApproval
  } = engineState.publishGate;
  return {
    ...engineState,
    publishGate: {
      ...publishGateWithoutApproval,
      publicationStatus: 'not_published',
    },
  };
}

function normalizeReplayPrerequisites(
  runId: string,
  existing: NonNullable<ReturnType<typeof getRun>>,
  flowSteps: readonly string[] | undefined,
  targetIdx: number,
  replayStepName: string,
): void {
  if (!flowSteps || targetIdx <= 0) return;
  const now = new Date().toISOString();
  for (let i = 0; i < targetIdx; i++) {
    const stepName = flowSteps[i];
    const prior = existing.steps.find((candidate) => candidate.name === stepName);
    if (!prior || prior.status === 'done' || prior.status === 'pending') continue;
    updateRunStep(runId, stepName, {
      status: 'done',
      completedAt: prior.completedAt ?? now,
      detail: `Normalized stale ${prior.status} prerequisite before replay from ${replayStepName}`,
      outputs: {
        ...(prior.outputs ?? {}),
        replayPrerequisiteNormalized: true,
        normalizedFromStatus: prior.status,
        normalizedForReplayStep: replayStepName,
      },
    });
  }
}

function recoverReplaySlotId(
  existing: NonNullable<ReturnType<typeof getRun>>,
  targetIdx: number,
  prepareIdx: number,
): string | null {
  if (targetIdx < 0 || prepareIdx < 0 || targetIdx < prepareIdx) return null;
  return resolveRunSlotId(existing);
}

function assertReplayAfterDispatchAllowed(
  existing: NonNullable<ReturnType<typeof getRun>>,
  flowSteps: readonly string[] | undefined,
  targetIdx: number,
  replayStepName: string,
): void {
  const workerLifecycleSteps = new Set<string>([PS.MONITOR, PS.SELF_REVIEW]);
  if (!workerLifecycleSteps.has(replayStepName)) return;
  if (!flowSteps || targetIdx < 0) return;
  const dispatchIdx = flowSteps.indexOf(PS.DISPATCH);
  if (dispatchIdx < 0 || targetIdx <= dispatchIdx) return;

  const dispatchStep = existing.steps.find((candidate) => candidate.name === PS.DISPATCH);
  if (!dispatchStep) {
    throw new Error(
      `Cannot replay ${replayStepName}: dispatch has not completed — replay from dispatch instead`,
    );
  }
  if (dispatchStep.status === 'done') return;
  if (dispatchStep.status === 'failed') {
    throw new Error(
      `Cannot replay ${replayStepName}: dispatch failed — replay from dispatch instead`,
    );
  }
  throw new Error(
    `Cannot replay ${replayStepName}: dispatch has not completed — replay from dispatch instead`,
  );
}

type SlotReclaimCheck =
  | { ok: true }
  | { ok: false; reason: 'owned-by-other'; owner: string }
  | { ok: false; reason: 'not-reclaimable'; lifecycle: string };

export function replaySlotReclaimCheck(
  slot: Readonly<Record<string, unknown>>,
  runId: string,
  options?: { ownerRunExists?: (ownerId: string) => boolean },
): SlotReclaimCheck {
  // A slot mid-release must never be reclaimed — even by the same run id
  // (the release is tearing that very claim down and would kill/reset
  // whatever lands here). This closes the same-run-id ABA on the owner check.
  if (slot.phase === SLOT_PHASE_RELEASING) {
    return { ok: false, reason: 'not-reclaimable', lifecycle: 'busy/releasing' };
  }
  // A pending handoff reservation for another run blocks reclaim the same
  // way a release fence does — the reserved run's delivery is in flight.
  const reserved = typeof slot.handoff_run_id === 'string' ? slot.handoff_run_id : '';
  if (reserved && reserved !== runId) {
    return { ok: false, reason: 'owned-by-other', owner: reserved };
  }
  const owner = typeof slot.current_run_id === 'string' ? slot.current_run_id : '';
  if (owner && owner !== runId) {
    const ownerStillActive = options?.ownerRunExists?.(owner) ?? true;
    if (ownerStillActive) return { ok: false, reason: 'owned-by-other', owner };
    return { ok: true };
  }

  const lifecycle = typeof slot.lifecycle === 'string' ? slot.lifecycle : '';
  if (owner === runId) return { ok: true };
  if (lifecycle === '' || lifecycle === 'ready' || lifecycle === 'released') return { ok: true };
  return { ok: false, reason: 'not-reclaimable', lifecycle };
}

// Index of the pipeline step that produces a given decision, using the
// DecisionType prefix convention (monitor_* → MONITOR, ci_* → CI_WATCH). Returns
// -1 for types whose ownership is not step-scoped by prefix; the completion/gate
// clearing branches handle those. A replay re-runs every step from its target
// onward, so a still-open decision owned by one of those re-run steps is stale
// and must be dropped — otherwise a monitor handoff from a prior generation
// lingers after a replay from prepare and re-blocks the reset run.
function decisionOwningStepIndex(type: string, flowSteps: readonly string[] | undefined): number {
  if (!flowSteps) return -1;
  if (type.startsWith('monitor_')) return flowSteps.indexOf(PS.MONITOR);
  if (type.startsWith('ci_')) return flowSteps.indexOf(PS.CI_WATCH);
  return -1;
}

export async function runReplayStep(
  params: RunReplayStepParams,
  emit: Emit,
): Promise<RunReplayStepResult> {
  if (
    params.triggeredBy !== undefined &&
    params.triggeredBy !== 'auto-recovery' &&
    params.triggeredBy !== 'operator'
  ) {
    throw new Error(`Invalid runReplayStep triggeredBy: ${String(params.triggeredBy)}`);
  }
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);
  if (existing.readOnly) {
    throw new Error(
      `Run ${params.runId.slice(0, 8)} is a read-only imported reference and cannot be replayed`,
    );
  }
  // Replaying a cancelled run is supported (e.g. resuming ci-watch on an
  // update-branch run). Cancelling released the node, so the graph may have
  // re-queued its work. Claim-aware reclaim (below) revokes any exclusive queue
  // claim before the run goes live, so a dispatcher that loses the claim stops
  // before createRun rather than racing a revived run. No entry-time refuse on
  // `dispatching` — claims replaced that weaker status-flag guard.
  const triggeredBy = params.triggeredBy ?? 'operator';

  const flowSteps = FLOW_STEPS[existing.flowType];
  const writeTaskIdx = flowSteps ? flowSteps.indexOf(PS.WRITE_TASK) : -1;
  const replayTargetIdx = flowSteps
    ? flowSteps.indexOf(params.stepName as (typeof flowSteps)[number])
    : -1;
  const replayWouldRegenerateTask =
    writeTaskIdx >= 0 && replayTargetIdx >= 0 && replayTargetIdx <= writeTaskIdx;

  // Pre-flight validation: if the stored ticketOrPr doesn't match the flow's expected
  // shape, retrying will hit the same error every time. Fail loudly at the entry so
  // the user understands the run is unrecoverable and needs to be recreated with a
  // correct reference (rather than seeing the same deep "write-task" error repeatedly).
  // Chained follow-ups (update-branch, pr-complete) keep the Jira key in ticketOrPr
  // while prNumber holds the linked PR — same split fetchPRData uses at runtime.
  // Only skip validation for post-write-task replays: write-task still derives PR vars
  // from ticketOrPr and would mis-hydrate tasks if we bypassed on earlier steps.
  const chainedPrReplay =
    PR_BOUND_FLOW_TYPES.has(existing.flowType as FlowType) &&
    hasValidPrNumber(existing) &&
    !replayWouldRegenerateTask;
  if (
    !isInternalArtifactOnlyEvalTicket(existing) &&
    !(isInteractiveDevRun(existing) && isLocalDevRef(existing.ticketOrPr)) &&
    !chainedPrReplay &&
    !isStoredManualBacklogRun(existing)
  ) {
    try {
      validateTicketRef(existing.ticketOrPr, existing.flowType);
    } catch (err) {
      throw new Error(
        `Cannot replay run: ${(err as Error).message}. ` +
          `The stored ticketOrPr is invalid for this flow — delete this run and create a new one with a correct reference.`,
      );
    }
  }

  let replayStepName = params.stepName;
  let targetIdx = replayTargetIdx;
  const findSlotIdx = flowSteps ? flowSteps.indexOf(PS.FIND_SLOT) : -1;
  const prepareIdx = flowSteps ? flowSteps.indexOf(PS.PREPARE) : -1;
  const monitorIdx = flowSteps ? flowSteps.indexOf(PS.MONITOR) : -1;
  const selfReviewIdx = flowSteps ? flowSteps.indexOf(PS.SELF_REVIEW) : -1;
  const completeIdx = flowSteps ? flowSteps.indexOf(PS.COMPLETE) : -1;
  const humanGateIdx = flowSteps ? flowSteps.indexOf(PS.HUMAN_GATE) : -1;
  if (
    existing.engineState?.evalExperiment &&
    targetIdx >= 0 &&
    prepareIdx >= 0 &&
    monitorIdx >= 0 &&
    targetIdx > prepareIdx &&
    targetIdx <= monitorIdx
  ) {
    replayStepName = PS.PREPARE;
    targetIdx = prepareIdx;
    console.log(
      `[run] replay from ${params.stepName} — starting at prepare so eval harness is reinstalled`,
    );
  }

  const step = existing.steps.find((s) => s.name === replayStepName);
  if (!step) throw new Error(`Step not found: ${params.stepName}`);

  // Ownership refuse before any mutation. Sync repair/normalize run next (no
  // await). Durable soft-lock is taken immediately before the first long await
  // (engine cancel / slot reclaim) so concurrent claim cannot win mid-replay.
  if (existing.status === 'cancelled' && existing.workGraphId && existing.workNodeId) {
    assertCancelledReplayNodeAvailable(existing, params.runId);
  }

  const replaySnapshot = getRun(params.runId) ?? existing;
  assertReplayAfterDispatchAllowed(replaySnapshot, flowSteps, targetIdx, replayStepName);
  normalizeReplayPrerequisites(params.runId, replaySnapshot, flowSteps, targetIdx, replayStepName);

  // Exclusive soft-lock via claim API (revoke-and-take) so replay shares the
  // same invariants as dispatch and UI gets queue.updated on claim/release.
  let softLock: QueueClaim | undefined;
  const releaseSoftLockIfHeld = async (): Promise<void> => {
    if (!softLock) return;
    if (releaseQueueClaim(softLock)) {
      await persistQueueNow();
    }
  };
  if (existing.status === 'cancelled' && existing.workGraphId && existing.workNodeId) {
    // Re-check after sync prep, then durable soft-lock before any further await.
    assertCancelledReplayNodeAvailable(existing, params.runId);
    const replacement = getQueueSnapshot().find((item) => isReplacementFor(item, existing));
    if (replacement) {
      const holder = `replay:${params.runId}:${randomUUID()}`;
      // Soft-lock claim is recorded before await so a persist failure still
      // releases in-memory claim fields (failure cleanup cannot race assignment).
      const claim = claimQueueItemForReplay(replacement.id, holder, { ttlMs: 120_000 });
      if (!claim) {
        throw new Error(
          `Run ${params.runId.slice(0, 8)} could not be replayed: could not soft-lock ` +
            `replacement queue item ${replacement.id.slice(0, 8)}.`,
        );
      }
      softLock = claim;
      try {
        await persistQueueNow();
      } catch (err) {
        await releaseSoftLockIfHeld();
        softLock = undefined;
        throw err;
      }
    }
  }

  try {
    // Invalidate any in-flight engine loop so it bails instead of overwriting our state.
    // Do this only after replay entry validation so rejected replays do not leave a
    // synthetic in-progress recovery lane behind.
    cancelRunEngine(params.runId);
    bumpRunGeneration(params.runId);

    const replaysCompletionOrGate =
      targetIdx >= 0 &&
      completeIdx >= 0 &&
      humanGateIdx >= 0 &&
      targetIdx >= completeIdx &&
      targetIdx <= humanGateIdx;
    const replaysPostGate = targetIdx >= 0 && humanGateIdx >= 0 && targetIdx > humanGateIdx;
    const replaysTaskGeneration = targetIdx >= 0 && writeTaskIdx >= 0 && targetIdx <= writeTaskIdx;
    // Supersede pending human-gate decisions NOW, before any awaited work: the
    // engine loop was just cancelled, so a stale decision resolving during the
    // slot/artifact awaits below would trigger runResolveDecision's restart
    // fallback and start a competing engine loop at this replay's generation.
    // Persisting the supersession synchronously closes that window — the
    // resolver rejects already-resolved decisions from here on. Retained (not
    // deleted) for audit; 'superseded' is not an approval action so
    // decision-replay can never mistake it for an operator verdict. Scoped to
    // the gate/task-generation replay paths only — a no-human-gate finalize
    // retry must keep its pending decisions actionable.
    const supersededGateAudit =
      replaysTaskGeneration || replaysCompletionOrGate
        ? existing.decisions.filter((d) => d.type === 'engine_human_gate' && !d.resolvedAt)
        : [];
    if (supersedeStaleHumanGateDecisions(supersededGateAudit) > 0) {
      updateRun(params.runId, { decisions: existing.decisions });
    }

    let replayTaskFile = existing.taskFile ?? null;
    let effectiveSlotId = existing.slotId;

    if (targetIdx >= 0 && writeTaskIdx >= 0 && targetIdx > writeTaskIdx && !replayTaskFile) {
      const writeTaskStep = existing.steps.find((candidate) => candidate.name === PS.WRITE_TASK);
      const taskFile = writeTaskStep?.outputs?.taskFile;
      if (typeof taskFile === 'string' && taskFile.trim()) {
        replayTaskFile = taskFile;
        console.log(
          `[run] replay from ${replayStepName} — restored taskFile from write-task output`,
        );
      }
    }

    // If replaying from find-slot or earlier, clear slot so it picks fresh
    if (targetIdx >= 0 && targetIdx <= findSlotIdx) {
      replayTaskFile = null;
      effectiveSlotId = null;
      updateRun(params.runId, { slotId: null, taskFile: null });
      console.log(
        `[run] replay from ${replayStepName} — cleared slotId + taskFile for re-selection`,
      );
    } else if (targetIdx >= 0 && targetIdx <= writeTaskIdx) {
      // Replaying from write-task: clear taskFile so it regenerates with current slot
      replayTaskFile = null;
      updateRun(params.runId, { taskFile: null });
      console.log(`[run] replay from ${replayStepName} — cleared taskFile for regeneration`);
    } else {
      const replaySlotId = recoverReplaySlotId(replaySnapshot, targetIdx, prepareIdx);
      if (replaySlotId) {
        // Re-claim only when the slot is free or still owned by this run. A released run
        // can keep stale agentContext.slotId history after its slot is reassigned; blindly
        // writing slot status here would steal that physical worker from the new run.
        try {
          // Claim-type write: bumps the ownership epoch so a teardown racing this
          // reclaim aborts its remaining writes instead of clobbering it.
          const { claimSlotStatusIf } = await import('../../core/index.js');
          const { claimed } = await claimSlotStatusIf(
            replaySlotId,
            (slot) =>
              replaySlotReclaimCheck(slot, params.runId, {
                ownerRunExists: (ownerId) => Boolean(getRun(ownerId)),
              }).ok,
            {
              lifecycle: 'busy',
              phase: 'preparing',
              agent: 'orchestrator',
              current_run_id: params.runId,
              current_flow_type: existing.flowType || null,
              current_ticket_or_pr: existing.ticketOrPr,
              current_mode: existing.mode ?? null,
              current_family_id: existing.familyId ?? null,
              current_lane: existing.lane ?? null,
              current_variant: existing.variant ?? null,
            },
          );
          if (!claimed) {
            throw new Error(
              `slot ${replaySlotId} is no longer safely reclaimable; replay from find-slot to select a fresh worker`,
            );
          }
          effectiveSlotId = replaySlotId;
          updateRun(params.runId, { slotId: replaySlotId });
          console.log(`[run] replay from ${replayStepName} — re-claimed slot ${replaySlotId}`);
        } catch (err) {
          console.warn(`[run] slot re-claim failed (${(err as Error).message})`);
          throw err;
        }
      }
    }

    // Drop branch-affinity nudge hints on any replay. The flags were set at run.create time
    // against a slot snapshot that's now stale — the re-claim above flips agent to
    // 'orchestrator', which fails `verifyBranchAffinityNudgeStillEligible`'s `agent==='working'`
    // gate. Retrying with the same nudge hint hits the same dead end. Engine routes through
    // fresh `dispatchExecute` instead, which is what replay semantics actually want: rebuild
    // the slot from a known state rather than rely on the original busy-worker assumption.
    // Regression introduced by PR #41 (d2442088, 2026-05-01); replays of pre-PR runs always
    // worked because every DISPATCH was fresh.
    //
    // CI-watch chained follow-ups (parentRunId + pr-complete/review-pr/update-branch) set
    // skipPrepare because the parent just finished on a keep-warm slot. Clearing that flag
    // on write-task replay forces a full PREPARE and tears down the hot workspace the chain
    // was meant to reuse — preserve it; only nudgeReuse is always stale after replay.
    const isChainedFollowUp = Boolean(existing.parentRunId) && isFollowUpFlow(existing.flowType);
    const willRerunPrepare = targetIdx >= 0 && prepareIdx >= 0 && targetIdx <= prepareIdx;
    const keepHotSlotSkipPrepare = isChainedFollowUp && Boolean(effectiveSlotId);
    if (existing.engineState?.flags?.nudgeReuse || existing.engineState?.flags?.skipPrepare) {
      const newFlags = { ...existing.engineState.flags };
      delete newFlags.nudgeReuse;
      if (!keepHotSlotSkipPrepare) {
        delete newFlags.skipPrepare;
      }
      const currentEngineState = getRun(params.runId)?.engineState ?? existing.engineState;
      updateRun(params.runId, {
        engineState: { ...currentEngineState, flags: newFlags },
      });
      console.log(
        keepHotSlotSkipPrepare
          ? `[run] replay from ${replayStepName} — cleared nudgeReuse; preserved skipPrepare (CI-watch chained follow-up)`
          : `[run] replay from ${replayStepName} — cleared nudgeReuse/skipPrepare flags (fresh dispatch)`,
      );
    } else if (keepHotSlotSkipPrepare && willRerunPrepare) {
      // Prior replay may have already cleared skipPrepare — restore hot-slot semantics.
      setRunFlags(params.runId, { skipPrepare: true });
      console.log(
        `[run] replay from ${replayStepName} — restored skipPrepare (CI-watch chained follow-up)`,
      );
    }

    // Replaying from self-review or later must clear nested-loop artifacts and active task variants.
    if (
      effectiveSlotId &&
      existing.taskFile &&
      targetIdx >= 0 &&
      selfReviewIdx >= 0 &&
      targetIdx >= selfReviewIdx
    ) {
      try {
        const {
          loadSlotVars,
          loadProjectVars,
          getOrchestratorTaskRoot,
          resolveProjectTaskDirName,
          resolveTaskRelDir,
        } = await import('../../core/config.js');
        const vars = await loadSlotVars(effectiveSlotId);
        const pv = await loadProjectVars(existing.project).catch(() => null);
        const taskRelDir = resolveTaskRelDir(
          existing.taskFile,
          getOrchestratorTaskRoot(existing.project, pv?.projectJson ?? null),
        );
        if (taskRelDir !== null) {
          const taskDirName = pv ? resolveProjectTaskDirName(pv.projectJson) : DEFAULT_TASK_DIR;
          const taskDirRel = `${taskDirName}/${taskRelDir}`;
          const workerTaskDir = `${vars.remoteRepo}/${taskDirRel}`;
          const preserveSelfReviewFix =
            existing.agentContexts?.some(
              (ctx) => ctx.role === 'self-review-fix' && ctx.status === 'working',
            ) ?? false;
          const {
            CHECKLIST_TARGET_BY_AGENT_ROLE,
            restoreWorkerChecklistTargetFromSlot,
            syncChecklistTargetForRole,
          } = await import('../../tasks/checklist-target.js');
          const selfReviewTarget = CHECKLIST_TARGET_BY_AGENT_ROLE['self-review'];
          const selfReviewFixTarget = CHECKLIST_TARGET_BY_AGENT_ROLE['self-review-fix'];
          const ciFixTarget = CHECKLIST_TARGET_BY_AGENT_ROLE['ci-fix'];
          const nestedFiles = [
            `${workerTaskDir}/${selfReviewTarget.checklist}`,
            `${workerTaskDir}/${selfReviewTarget.signal}`,
            ...(preserveSelfReviewFix
              ? []
              : [
                  `${workerTaskDir}/${selfReviewFixTarget.checklist}`,
                  `${workerTaskDir}/${selfReviewFixTarget.signal}`,
                ]),
            `${workerTaskDir}/${ciFixTarget.checklist}`,
            `${workerTaskDir}/${ciFixTarget.signal}`,
          ];
          await execOnSlot(
            vars,
            `rm -f ${nestedFiles.map(shellQuote).join(' ')} 2>/dev/null`,
            vars.remoteRepo,
          );
          if (preserveSelfReviewFix) {
            await syncChecklistTargetForRole(vars, taskDirRel, 'self-review-fix');
          } else {
            await restoreWorkerChecklistTargetFromSlot(vars, taskDirRel, {
              flowType: existing.flowType,
              mode: existing.mode ?? undefined,
            });
          }
          console.log(
            `[run] replay from ${replayStepName} — cleared nested-loop task artifacts in ${workerTaskDir}${preserveSelfReviewFix ? ' (preserved active self-review-fix)' : ''}`,
          );
        }
      } catch (err) {
        console.warn(`[run] nested-loop cleanup failed (${(err as Error).message})`);
      }
    }

    const replaysWorkerLaunch =
      targetIdx >= 0 &&
      prepareIdx >= 0 &&
      monitorIdx >= 0 &&
      targetIdx >= prepareIdx &&
      targetIdx <= monitorIdx;

    if (replaysWorkerLaunch && effectiveSlotId && existing.taskFile) {
      try {
        const {
          loadSlotVars,
          loadProjectVars,
          getOrchestratorTaskRoot,
          resolveProjectTaskDirName,
          resolveTaskRelDir,
        } = await import('../../core/config.js');
        const vars = await loadSlotVars(effectiveSlotId);
        const pv = await loadProjectVars(existing.project).catch(() => null);
        const taskRelDir = resolveTaskRelDir(
          existing.taskFile,
          getOrchestratorTaskRoot(existing.project, pv?.projectJson ?? null),
        );
        if (taskRelDir !== null) {
          const taskDirName = pv ? resolveProjectTaskDirName(pv.projectJson) : DEFAULT_TASK_DIR;
          const workerTaskDir = `${vars.remoteRepo}/${taskDirName}/${taskRelDir}`;
          const { CHECKLIST_TARGET_BY_AGENT_ROLE, WORKER_SIGNAL_FILE } =
            await import('../../tasks/checklist-target.js');
          const selfReviewTarget = CHECKLIST_TARGET_BY_AGENT_ROLE['self-review'];
          const selfReviewFixTarget = CHECKLIST_TARGET_BY_AGENT_ROLE['self-review-fix'];
          const ciFixTarget = CHECKLIST_TARGET_BY_AGENT_ROLE['ci-fix'];
          await execOnSlot(
            vars,
            `rm -f ${shellQuote(`${workerTaskDir}/${WORKER_SIGNAL_FILE}`)} ` +
              `${shellQuote(`${workerTaskDir}/${selfReviewTarget.signal}`)} ` +
              `${shellQuote(`${workerTaskDir}/${selfReviewFixTarget.signal}`)} ` +
              `${shellQuote(`${workerTaskDir}/${ciFixTarget.signal}`)} 2>/dev/null`,
            vars.remoteRepo,
          );
          console.log(
            `[run] replay from ${replayStepName} — cleared worker terminal signals in ${workerTaskDir}`,
          );
        }
      } catch (err) {
        console.warn(`[run] worker signal cleanup failed (${(err as Error).message})`);
      }
    }

    // Reset this step and all subsequent steps to pending
    const stepIdx = existing.steps.indexOf(step);
    for (let i = stepIdx; i < existing.steps.length; i++) {
      updateRunStep(params.runId, existing.steps[i].name, {
        status: 'pending',
        startedAt: undefined,
        completedAt: undefined,
        durationMs: undefined,
        inputs: undefined,
        outputs: undefined,
        detail: undefined,
      });
    }

    // Clear decisions when replaying the completion/gate path so stale CI/review
    // decisions do not short-circuit or re-block it. Preserve resolved human-gate
    // approvals when replaying post-gate steps (finalize/ci-watch): those replays
    // are publish retries for an already-approved package, and clearing the
    // approval makes recovery impossible without forcing a redundant re-review.
    // Flows without a human gate keep the default behavior below: preserve only
    // unresolved decisions rather than inventing a gate boundary they do not have.
    // The supersession itself already happened synchronously right after the
    // generation bump (before the first awaited operation); this just selects
    // which decisions the reset below carries forward.
    const clearedDecisions =
      replaysTaskGeneration || replaysCompletionOrGate
        ? supersededGateAudit
        : replaysPostGate
          ? existing.decisions
          : existing.decisions.filter((d) => {
              if (d.resolvedAt) return false;
              // Drop an unresolved decision whose owning step is being replayed
              // (targetIdx onward re-runs and regenerates it). Preserve ones owned
              // by steps before the target — still actionable — or of unknown
              // ownership (prior default behavior).
              const ownerIdx = decisionOwningStepIndex(d.type, flowSteps);
              return ownerIdx < 0 || ownerIdx < targetIdx;
            });

    // Reset run status, clear error and stale outcome
    const {
      outcome: _outcome,
      disposition: _disposition,
      terminalEvidence: _terminalEvidence,
      durationMs: _durationMs,
      costEstimate: _costEstimate,
      sessionTurns: _sessionTurns,
      sessionInputTokens: _sessionInputTokens,
      sessionOutputTokens: _sessionOutputTokens,
      sessionCacheCreation: _sessionCacheCreation,
      sessionCacheRead: _sessionCacheRead,
      sessionTotalTokens: _sessionTotalTokens,
      actualModel: _actualModel,
      ...metricsWithoutTerminalOutcome
    } = existing.metrics;
    const resetMetrics = replaysWorkerLaunch
      ? {
          ...metricsWithoutTerminalOutcome,
          nudgeCount: 0,
          runnerSessionId: null,
          runnerSessionPath: null,
        }
      : { ...metricsWithoutTerminalOutcome };
    const attemptCount =
      (existing.recoveryAttempts ?? []).filter(
        (attempt) => attempt.stepName === replayStepName && attempt.triggeredBy === triggeredBy,
      ).length + 1;
    const attempt = {
      id: randomUUID(),
      attempt: attemptCount,
      stepName: replayStepName,
      startedAt: new Date().toISOString(),
      status: 'started' as const,
      triggeredBy,
      ...(params.intelligenceActionId ? { intelligenceActionId: params.intelligenceActionId } : {}),
    };
    const proposalStatus =
      triggeredBy === 'auto-recovery'
        ? ('auto-in-progress' as const)
        : ('manual-in-progress' as const);
    const replayGeneration =
      getRun(params.runId)?.engineState?.generation ?? existing.engineState?.generation ?? 0;
    const currentBeforeReplayUpdate = getRun(params.runId) ?? existing;
    const engineStateForReplay = replaysCompletionOrGate
      ? resetPublishGateApprovalForReplay(currentBeforeReplayUpdate.engineState)
      : currentBeforeReplayUpdate.engineState;
    // Soft-lock was taken before long awaits. Re-validate holder+epoch and live
    // ownership before revive: expiry reclaim or concurrent replay may have stolen it.
    if (
      currentBeforeReplayUpdate.status === 'cancelled' &&
      existing.workGraphId &&
      existing.workNodeId
    ) {
      assertCancelledReplayNodeAvailable(existing, params.runId);
      const held = softLock;
      if (held) {
        const locked = getQueueSnapshot().find((item) => item.id === held.itemId);
        if (!locked) {
          throw new Error(
            `Run ${params.runId.slice(0, 8)} could not be replayed: its replacement queue work ` +
              `was removed during prep (cancel/reclaim). The cancelled run is left cancelled.`,
          );
        }
        // Renew via claim API — fails when holder/epoch no longer match.
        if (!renewQueueClaim(held, { ttlMs: 60_000 })) {
          throw new Error(
            `Run ${params.runId.slice(0, 8)} could not be replayed: lost exclusive soft-lock on ` +
              `replacement queue item ${locked.id.slice(0, 8)}. The cancelled run is left cancelled.`,
          );
        }
      }
    }
    updateRun(params.runId, {
      status: activeStatusForReplayStep(replayStepName),
      error: undefined,
      completedAt: undefined,
      taskFile: replayTaskFile,
      decisions: clearedDecisions,
      engineState: engineStateForReplay,
      metrics: resetMetrics,
      monitorState: undefined,
      activeTaskFile: undefined,
      recoveryProposal: {
        status: proposalStatus,
        proposalId: params.intelligenceActionId,
        generation: replayGeneration,
      },
      recoveryAttempts: [...(existing.recoveryAttempts ?? []), attempt],
    });
    // Durable revive before dropping replacement work — crash between these two
    // leaves a live owner on disk; loadQueue drops any same-candidate row even when
    // launchAttempt differs (N vs N+1 requeue).
    await persistRunNow(getRun(params.runId)!, 'replay-revive');
    const lockToDrop = softLock;
    if (lockToDrop) {
      if (getQueueSnapshot().some((item) => item.id === lockToDrop.itemId)) {
        removeQueueItemInternal(lockToDrop.itemId, `replay-revives-run:${params.runId}`);
        await persistQueueNow();
      }
      softLock = undefined; // dropped — do not re-release in catch
    }
    emit(Events.RUN_UPDATED, { run: getRun(params.runId) });

    // Retry-with-profile: persist the selection so the replayed PREPARE (and any
    // later replay) uses it — profile choice is run state, not a one-shot flag.
    if (params.prepareProfile) {
      updateRun(params.runId, { prepareProfile: params.prepareProfile });
    }

    // Binary operator skip — no health gating (ADR-037 §5)
    if (params.skipPrepare) {
      setRunFlags(params.runId, { skipPrepare: true });
    }

    // Re-drive the engine from the reset step. Test contexts can disable the
    // engine start (same switch runCreate honors) to assert the primed
    // pipeline state deterministically.
    if (
      process.env.NODE_TEST_CONTEXT !== '1' ||
      process.env.FARMSLOT_DISABLE_RUN_ENGINE_START !== '1'
    ) {
      startRun(params.runId).catch((err) => {
        console.error(`[run] replay failed: ${(err as Error).message}`);
      });
    }

    console.log(`[run] replaying ${params.runId.slice(0, 8)} from step ${replayStepName}`);
    return { run: getRun(params.runId)! };
  } catch (err) {
    await releaseSoftLockIfHeld();
    throw err;
  }
}
