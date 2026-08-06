// run-engine.ts — Workflow state machine for Runs
// Drives a Run through its lifecycle steps, calling existing gateway methods.
import path from 'node:path';

import {
  Events,
  type EvidenceManifestEntry,
  FLOW_STEPS,
  type FlowType,
  PipelineSteps,
  type Run,
  type RunDecisionPayload,
  type RunStatus,
} from '@farmslot/protocol';

import { reconcileRunAgentRuntime } from '../agents/runtime-recovery.js';
import {
  getProjectField,
  getProjectFieldRaw,
  loadProjectVars,
  loadSlotVars,
} from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { expandHook, expandTemplate } from '../core/hooks.js';
import { resetSlot, SLOT_PHASE_RELEASING } from '../core/state.js';
import { loadFleetStatus, setPrHealthOverlay } from '../fleet/state.js';
import { failedRunSlotCleanup, isSlotClaimRefusedError } from '../methods/dispatch/slot-scoring.js';
import { clearStalePrepareProcess } from '../methods/slot.js';
import { scanArtifacts } from '../run-completion/orchestrator.js';
import {
  createRun,
  getRun,
  listRuns,
  quarantineLeakedRun,
  updateRun,
  updateRunStep,
} from '../runs/store.js';
import { isNoCodeTerminalDisposition } from '../tasks/worker-signals.js';

import { buildCIWatchChainedRunParams } from './ci-watch-chain.js';
import { executeCIWatchStep } from './ci-watch-step.js';
import { latestResolvedHumanGateDecision, requiresCollisionPrecheck } from './decision-replay.js';
import { executeDispatchStep, executePrepareStep } from './dispatch-lifecycle-steps.js';
import {
  buildDispatchPreviewParamsForRun,
  determineSelectionMethodForRun,
  resolveCIWatchTerminalPatch,
  resolveRunDispatchRunnerModel,
} from './dispatch-policy.js';
import {
  createEngineDecision,
  handleCollisionDecision,
  RedirectedError,
  setEngineDecisionRuntime,
} from './engine-decisions.js';
import { BlockedRunError } from './errors.js';
import { executeEvalHarnessLifecycle } from './eval-harness-lifecycle.js';
import { normalizeEvalReplayForTaskWrite } from './eval-replay-normalization.js';
import { executeFinalizeStep } from './finalize-step.js';
import { executeFindSlotStep } from './find-slot-step.js';
import { teardownGateHeldAgentsIfNeeded } from './gate-held-lifecycle.js';
import {
  buildNoChangeGateInputs,
  hasValidPrNumber,
  noChangeDispositionLabel,
  noChangeRejectionMessage,
} from './gate-policy.js';
import {
  executeCompleteStep,
  executeHumanGateStep,
  executeMonitorStep,
  executeSelfReviewStep,
} from './post-dispatch-steps.js';
import { loadProjectVarsOrNull } from './project-vars.js';
import { setPublishPackageRefreshBroadcast } from './publish-package-refresh.js';
import {
  executePublishGateReviewPlan,
  executeReadyGate,
  readPreparedPackage,
} from './ready-gate.js';
import {
  isTerminalReviewArtifactError,
  recoverInflightPublicationReviews,
} from './recover-inflight-reviews.js';
import {
  hasRecoverablePublicationReviewer,
  isPublicationReviewRecoveryHeld,
  markTerminalReviewArtifactOperatorRequired,
  recoverActiveRuns as recoverActiveRunsImpl,
  type RunRecoveryCollaborators,
  startOrphanReconciler as startOrphanReconcilerImpl,
} from './recovery.js';
import { copyWorkerArtifacts, readReviewArtifacts } from './review-artifacts.js';
import { executeReviewGate, setReviewGateBroadcast } from './review-gate.js';
import { refreshRunLinks } from './run-links.js';
import { rearmInteractiveHandoffAutoRecovery } from './run-monitor.js';
import { getDiffStat, readTaskArtifactText, readWorkerReport } from './task-artifacts.js';
import { executeGradeStep, executeWriteTaskStep } from './task-steps.js';
import { copyTaskFilesToSlot } from './task-sync.js';
type BroadcastFn = (event: string, payload: unknown) => void;
let broadcastFn: BroadcastFn = () => {};
function interactiveLightweightSkipOutputs(step: string): StepIO {
  return {
    inputs: { enabled: false, policy: 'interactive-lightweight', step },
    outputs: {
      skipped: true,
      reason: 'interactive-lightweight-policy',
      source: 'operator-policy',
    },
  };
}
/**
 * Thrown by MONITOR (or any future step) when a worker self-signals a terminal status
 * (`blocked` / `failed`) without the step itself failing. Carries the step's I/O so the
 * outer catch can mark the step `done` (it actually completed) and the run terminal in a
 * single typed branch — keeping all "step succeeded but run is over" routing exception-driven
 * instead of relying on the post-step status sniff in startRun (which remains as a
 * defensive backstop only).
 */
class MonitorTerminalError extends Error {
  readonly status: 'failed' | 'blocked';
  readonly outcome: 'partial' | 'failure';
  readonly stepInputs: Record<string, unknown>;
  readonly stepOutputs: Record<string, unknown>;
  constructor(opts: {
    status: 'failed' | 'blocked';
    outcome: 'partial' | 'failure';
    reason: string;
    stepInputs: Record<string, unknown>;
    stepOutputs: Record<string, unknown>;
  }) {
    super(opts.reason);
    this.name = 'MonitorTerminalError';
    this.status = opts.status;
    this.outcome = opts.outcome;
    this.stepInputs = opts.stepInputs;
    this.stepOutputs = opts.stepOutputs;
  }
}
const S = PipelineSteps;

/**
 * A terminal run may reset only a slot it OWNS — and even then a pending
 * foreign handoff reservation survives (the incoming nudge's delivery is
 * mid-flight; see failedRunSlotCleanup). A run that merely held a
 * reservation clears just that reservation — the prior owner's worker is
 * still running and must not be marked ready — and a run named nowhere on
 * the slot touches nothing.
 *
 * Classification and the matching write happen in ONE serialized transition:
 * a per-plan CAS cascade let a rival write shift the plan between attempts
 * and strand the slot. The full-reset branch first fences the slot as
 * `releasing` (every claim path refuses it), runs the caller's destructive
 * process/agent teardown behind that fence — never on an unfenced slot a
 * rival could claim or reserve mid-kill — then applies the final reset
 * guarded on the fence epoch, mirroring slotRelease. A slot already
 * mid-release is left to the release that owns the teardown.
 */
async function cleanupSlotAfterRunFailure(
  slotId: string,
  runId: string,
  reason: string,
  destructiveCleanup?: () => Promise<void>,
): Promise<void> {
  const { readSlotField, resetSlotIf, slotOwnershipReleaseFields, transitionSlotStatus } =
    await import('../core/index.js');
  // Object holder rather than a `let`: assignments inside the decide closure
  // are invisible to control-flow narrowing on a plain local.
  const planRef: {
    value: ReturnType<typeof failedRunSlotCleanup> | 'already-releasing';
    escalated: boolean;
  } = { value: 'none', escalated: false };
  const transition = await transitionSlotStatus(slotId, (slot) => {
    if (slot.phase === SLOT_PHASE_RELEASING) {
      planRef.value = 'already-releasing';
      return null;
    }
    const plan = failedRunSlotCleanup(slot, runId, getRun);
    planRef.value = plan;
    // Escalated: this run merely held the reservation and the recorded owner
    // is dead — the reset also owns physical worker teardown (below).
    planRef.escalated = plan === 'reset' && slot.current_run_id !== runId;
    switch (plan) {
      case 'reset':
        return { fields: { lifecycle: 'busy', phase: SLOT_PHASE_RELEASING } };
      case 'release-keep-handoff':
        return { fields: slotOwnershipReleaseFields(), endsOwnership: true };
      case 'clear-reservation':
        return { fields: { handoff_run_id: null } };
      default:
        return null;
    }
  });
  if (planRef.value === 'reset' && transition.applied) {
    if (planRef.escalated) {
      // The dead owner's worker may still be writing in the worktree (fresh
      // reuse escalates here precisely when its kill threw mid-teardown), so
      // it must be dead before the slot is published ready — otherwise the
      // next PREPARE races a live worker in the same checkout. A failed kill
      // leaves the releasing fence up: non-dispatchable and visible to the
      // operator, instead of a dispatchable row hiding a live worker.
      try {
        const runner = (await readSlotField(slotId, 'runner')) as string | null;
        if (!runner) {
          // No recorded runner identity: a worker (if any) cannot be
          // verifiably killed. Publishing ready would hand the next PREPARE
          // a possibly-live worker — keep the fence up for the operator.
          console.warn(
            `[run-engine] no runner recorded for ${slotId}; leaving the releasing fence up after ${reason}`,
          );
          return;
        }
        const { killWorkerOnSlot } = await import('../methods/dispatch/nudge.js');
        const { normalizeRunner } = await import('../runners/registry.js');
        await killWorkerOnSlot(slotId, normalizeRunner(runner));
      } catch (err) {
        console.warn(
          `[run-engine] worker kill failed for ${slotId} after ${reason}; leaving the releasing fence up: ${(err as Error).message.slice(0, 200)}`,
        );
        return;
      }
    }
    if (destructiveCleanup) {
      try {
        await destructiveCleanup();
      } catch (err) {
        // The fence must not strand the slot in `releasing`: surface the
        // teardown error but continue to the final reset.
        console.warn(
          `[run-engine] destructive cleanup for ${slotId} after ${reason}: ${(err as Error).message.slice(0, 200)}`,
        );
      }
    }
    await resetSlotIf(
      slotId,
      (slot) => (Number(slot.slot_epoch) || 0) === (transition.epoch ?? -1),
    );
    console.log(`[run-engine] slot ${slotId} reset to ready/idle after ${reason}`);
    return;
  }
  if (planRef.value === 'release-keep-handoff' && transition.applied) {
    console.log(
      `[run-engine] slot ${slotId} ownership released after ${reason}; pending handoff reservation preserved`,
    );
    return;
  }
  if (planRef.value === 'clear-reservation' && transition.applied) {
    console.log(`[run-engine] cleared handoff reservation on ${slotId} after ${reason}`);
    return;
  }
  console.log(
    `[run-engine] slot ${slotId} cleanup after ${reason}: ${planRef.value === 'already-releasing' ? 'in-flight release owns the teardown' : 'not owned by terminal run'}; left untouched`,
  );
}

const STEP_TO_STATUS: Record<string, RunStatus> = {
  [S.GRADE]: 'grading',
  [S.WRITE_TASK]: 'writing-task',
  [S.FIND_SLOT]: 'slot-finding',
  [S.PREPARE]: 'preparing',
  [S.DISPATCH]: 'dispatching',
  [S.MONITOR]: 'monitoring',
  [S.SELF_REVIEW]: 'self-reviewing',
  [S.HUMAN_GATE]: 'human-gating',
  [S.FINALIZE]: 'completing',
  [S.COMPLETE]: 'completing',
  [S.CI_WATCH]: 'ci-watching',
};
// Active monitor abort controllers — keyed by runId
const activeMonitors = new Map<string, AbortController>();
// ADR-027 Phase 2: runtime flags + replay generation counter persist on Run.engineState
// so warm-recovery hints and stale-loop guards survive gateway restart.
export function setRunFlags(
  runId: string,
  flags: {
    skipPrepare?: true;
    warmRecovery?: true;
    nudgeReuse?: true;
    freshReuse?: true;
    /** Opt-in integrate-main during review-pr prepare (merge commit, soft-fail). */
    mergeMain?: true;
    /** CI-watch chain: attempt warm worker handoff at DISPATCH. */
    warmSessionReuse?: true;
  },
): void {
  const run = getRun(runId);
  if (!run) return;
  const currentFlags = run.engineState?.flags ?? {};
  updateRun(runId, {
    engineState: { ...(run.engineState ?? {}), flags: { ...currentFlags, ...flags } },
  });
}
function getRunFlags(runId: string):
  | {
      skipPrepare?: true;
      warmRecovery?: true;
      nudgeReuse?: true;
      freshReuse?: true;
      mergeMain?: true;
      warmSessionReuse?: true;
    }
  | undefined {
  const flags = getRun(runId)?.engineState?.flags;
  if (!flags) return undefined;
  return {
    ...(flags.skipPrepare ? { skipPrepare: true as const } : {}),
    ...(flags.warmRecovery ? { warmRecovery: true as const } : {}),
    ...(flags.nudgeReuse ? { nudgeReuse: true as const } : {}),
    ...(flags.freshReuse ? { freshReuse: true as const } : {}),
    ...(flags.mergeMain ? { mergeMain: true as const } : {}),
    ...(flags.warmSessionReuse ? { warmSessionReuse: true as const } : {}),
  };
}
// Partial I/O stash — steps store their partial inputs/outputs before throwing,
// so the catch block in startRun() can persist them on failure.
const stepPartialIO = new Map<string, StepIO>();
export function bumpRunGeneration(runId: string): number {
  const run = getRun(runId);
  if (!run) return 0;
  const gen = (run.engineState?.generation ?? 0) + 1;
  updateRun(runId, { engineState: { ...(run.engineState ?? {}), generation: gen } });
  return gen;
}
function getRunGeneration(runId: string): number {
  return getRun(runId)?.engineState?.generation ?? 0;
}
export function initRunEngine(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
  setEngineDecisionRuntime({ broadcast, stepToStatus: STEP_TO_STATUS });
  setPublishPackageRefreshBroadcast(broadcast);
  setReviewGateBroadcast(broadcast);
}
export function applyChainedRunEngineFlags(
  runId: string,
  flags: { skipPrepare?: true; warmSessionReuse?: true },
): void {
  if (flags.skipPrepare || flags.warmSessionReuse) {
    setRunFlags(runId, {
      ...(flags.skipPrepare ? { skipPrepare: true as const } : {}),
      ...(flags.warmSessionReuse ? { warmSessionReuse: true as const } : {}),
    });
  }
}
// ─── Start / drive a run ───
async function cleanupEvalHarnessForTerminalRun(
  run: Run,
  runId: string,
  reason: string,
): Promise<void> {
  if (!run.slotId || !run.engineState?.evalExperiment) return;
  try {
    await executeEvalHarnessLifecycle(run, 'cleanup', { throwOnFailure: false });
  } catch (cleanupErr) {
    // The terminal run state is authoritative. Cleanup errors are logged so the
    // candidate package and slot can be inspected without hiding the root exit.
    console.warn(
      `[run-engine] eval harness cleanup after ${reason} failed for ${runId.slice(0, 8)}: ${(cleanupErr as Error).message.slice(0, 200)}`,
    );
  }
}

// Defensive backstop for any step that mutates run.status without throwing. As of the
// MonitorTerminalError refactor, MONITOR routes through the exception-driven catch and is
// no longer the primary trigger here — this remains in case a future contributor adds a new
// step that flips status via updateRun() instead of throwing a typed terminal error.
// Callers that take this branch *after* a step's success path must pass `currentIdx = i + 1`
// so the completed step keeps its 'done' record; the pre-step entry passes `currentIdx = i`
// so the pending step that observed the flip is correctly marked skipped.
async function finalizeNonThrownTerminalRun(
  runId: string,
  currentIdx: number,
  steps: readonly string[],
): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  // Defensive: cancelled/paused runs go through different cleanup paths; treat as a no-op
  // here so a misrouted call can't accidentally stomp the cancellation record.
  if (run.status !== 'failed' && run.status !== 'blocked') {
    console.warn(
      `[run-engine] finalizeNonThrownTerminalRun called with non-terminal status ${run.status} for ${runId.slice(0, 8)} — skipping`,
    );
    return;
  }
  for (let j = currentIdx; j < steps.length; j++) {
    const step = run.steps.find((s) => s.name === steps[j]);
    if (!step || step.status === 'pending' || step.status === 'running') {
      updateRunStep(runId, steps[j], { status: 'skipped' });
    }
  }
  if (!run.completedAt) {
    // Default outcome only when whoever flipped the status didn't already record one.
    // MONITOR is no longer expected to take this branch (it now throws MonitorTerminalError
    // which sets `outcome` in its catch); any future step that flips status without throwing
    // would land here and `metrics.outcome ??` ensures we don't clobber an already-set value.
    const inferredOutcome: 'partial' | 'failure' = run.status === 'blocked' ? 'partial' : 'failure';
    updateRun(runId, {
      completedAt: new Date().toISOString(),
      metrics: {
        ...run.metrics,
        durationMs: Date.now() - new Date(run.createdAt).getTime(),
        outcome: run.metrics.outcome ?? inferredOutcome,
      },
    });
  }
  await cleanupEvalHarnessForTerminalRun(run, runId, `non-thrown ${run.status}`);
  if (run.slotId) {
    const slotId = run.slotId;
    try {
      // Destructive teardown (stale worker/browser/webpack kill + gate-held
      // agents) runs INSIDE the cleanup helper, behind its releasing fence and
      // only when this run still owns the slot exclusively — an incoming
      // nudge's reserved worker must never be killed by the dying owner.
      // cleanupSlotProcesses is idempotent: it signals a prepare group only
      // when its opaque scope still matches a live member, while missing or
      // stale identities are removed without signalling. Calling it on flows
      // where prepare did not run is therefore a no-op.
      await cleanupSlotAfterRunFailure(slotId, runId, `non-thrown ${run.status}`, async () => {
        await cleanupSlotProcesses(slotId);
        const currentRun = getRun(runId);
        if (currentRun) {
          await teardownGateHeldAgentsIfNeeded(currentRun);
        }
      });
    } catch (err) {
      // Surface but do not mask the run's terminal state.
      console.warn(
        `[run-engine] slot reset after non-thrown ${run.status} for ${run.slotId}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
}
export async function startRun(runId: string): Promise<void> {
  const initialRun = getRun(runId);
  if (!initialRun) throw new Error(`Run not found: ${runId}`);
  // Eval replay task normalization is intentionally repeated here and again at
  // WRITE_TASK/PREPARE. startRun covers restart recovery, while the later gates
  // cover explicit reruns after reference metadata changes; the helper is
  // idempotent and returns early when no rewrite is needed.
  const run = await normalizeEvalReplayForTaskWrite(runId, initialRun);

  const steps = FLOW_STEPS[run.flowType];
  if (!steps) throw new Error(`Unknown flow type: ${run.flowType}`);

  // Capture generation — if a replay bumps it mid-loop, this loop should bail
  const myGen = getRunGeneration(runId);

  const startIdx = findStartStep(run, steps);
  console.log(
    `[run-engine] starting run ${runId.slice(0, 8)} from step ${startIdx}/${steps.length} (${steps[startIdx] ?? 'done'}) gen=${myGen}`,
  );

  for (let i = startIdx; i < steps.length; i++) {
    const stepName = steps[i];
    const current = getRun(runId);
    if (!current || current.status === 'cancelled' || current.status === 'paused') return;
    // Stale loop: a replay bumped the generation — bail so the new startRun takes over
    if (getRunGeneration(runId) !== myGen) {
      console.log(
        `[run-engine] run ${runId.slice(0, 8)} — stale loop (gen ${myGen} != ${getRunGeneration(runId)}), bailing`,
      );
      return;
    }
    if (current.status === 'failed' || current.status === 'blocked') {
      // A step's success path flipped the run to a terminal state without throwing
      // (e.g. MONITOR observed workerSignal.status='blocked'). The exception-driven
      // catch below — the only place that runs resetSlot + skip-remaining — never fires
      // on this path, so the slot would otherwise rot in busy/{phase}/idle forever.
      await finalizeNonThrownTerminalRun(runId, i, steps);
      return;
    }

    // Mark step running + update run status
    const status = STEP_TO_STATUS[stepName];
    updateRunStep(runId, stepName, {
      status: 'running',
      startedAt: new Date().toISOString(),
      detail: undefined,
      outputs: undefined,
      completedAt: undefined,
      durationMs: undefined,
    });
    updateRun(runId, { status });
    broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

    try {
      const stepIO = await executeStep(runId, stepName);

      // Re-check cancellation/pause after async step
      const after = getRun(runId);
      if (!after || after.status === 'cancelled' || after.status === 'paused') return;
      // A replay/resume that bumped the generation mid-step owns the run now —
      // the stale loop must not mark this step done or advance concurrently.
      if (getRunGeneration(runId) !== myGen) {
        console.log(
          `[run-engine] run ${runId.slice(0, 8)} — stale loop after step ${stepName} (gen ${myGen} != ${getRunGeneration(runId)}), bailing`,
        );
        return;
      }

      // Mark step done with I/O data BEFORE checking for terminal flip — executeStep returned
      // normally, so this step itself completed. A blocked/failed run-level status flipped by
      // MONITOR observing workerSignal is the *worker* outcome, not a step failure. Recording
      // the step as 'done' preserves an accurate timeline for the operator.
      const now = new Date().toISOString();
      const step = after.steps.find((s) => s.name === stepName);
      const durationMs = step?.startedAt
        ? Date.now() - new Date(step.startedAt).getTime()
        : undefined;
      updateRunStep(runId, stepName, {
        status: 'done',
        completedAt: now,
        durationMs,
        detail: undefined,
        inputs: stepIO.inputs,
        outputs: stepIO.outputs,
      });
      broadcastFn(Events.RUN_STEP_COMPLETED, { runId, step: stepName });
      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

      if (after.status === 'failed' || after.status === 'blocked') {
        // Step `i` is now correctly marked done; finalize only needs to skip steps i+1..end.
        await finalizeNonThrownTerminalRun(runId, i + 1, steps);
        return;
      }

      // After write-task: copy task files to slot immediately (so they're visible during prepare)
      if (stepName === S.WRITE_TASK) {
        await copyTaskFilesToSlot(runId);
      }
    } catch (err) {
      const msg = (err as Error).message;

      // Intentional redirect (collision → comparison-lane fork): the current run
      // was already cancelled with redirectedToRunId set before throwing. Mark
      // the step skipped, leave run status alone, and stop the pipeline. Without
      // this branch the outer logic would mark the run failed and overwrite the
      // clean cancelled+redirected state with a misleading error.
      if (err instanceof RedirectedError) {
        console.log(
          `[run-engine] run ${runId.slice(0, 8)} step ${stepName} redirected → ${err.successorRunId.slice(0, 8)}`,
        );
        updateRunStep(runId, stepName, {
          status: 'skipped',
          detail: 'Redirected to comparison lane',
        });
        for (let j = i + 1; j < steps.length; j++) {
          updateRunStep(runId, steps[j], { status: 'skipped' });
        }
        broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
        return;
      }

      // An operator may cancel while an asynchronous step is failing. The
      // operator-owned terminal state wins over the late exception.
      const interruptedRun = getRun(runId);
      if (!interruptedRun || interruptedRun.status === 'cancelled') {
        console.log(
          `[run-engine] run ${runId.slice(0, 8)} step ${stepName} threw after ${interruptedRun?.status ?? 'deletion'}; preserving operator state`,
        );
        return;
      }

      if (isTerminalReviewArtifactError(err)) {
        console.warn(
          `[run-engine] run ${runId.slice(0, 8)} step ${stepName} requires operator review: ${msg}`,
        );
        markTerminalReviewArtifactOperatorRequired({ updateRun }, interruptedRun, msg);
        updateRunStep(runId, stepName, {
          status: 'done',
          detail: msg,
          completedAt: new Date().toISOString(),
        });
        updateRun(runId, { status: 'blocked', error: msg });
        await finalizeNonThrownTerminalRun(runId, i + 1, steps);
        return;
      }

      if (err instanceof BlockedRunError) {
        console.log(
          `[run-engine] run ${runId.slice(0, 8)} step ${stepName} blocked without failure: ${err.message}`,
        );
        updateRunStep(runId, stepName, {
          status: 'done',
          detail: err.detail,
          completedAt: new Date().toISOString(),
        });
        for (let j = i + 1; j < steps.length; j++) {
          updateRunStep(runId, steps[j], { status: 'skipped' });
        }
        const blockedRun = getRun(runId)!;
        updateRun(runId, {
          status: 'blocked',
          completedAt: new Date().toISOString(),
          error: err.message,
          metrics: {
            ...blockedRun.metrics,
            outcome: 'partial',
            durationMs: Date.now() - new Date(blockedRun.createdAt).getTime(),
          },
        });
        if (blockedRun.slotId) {
          await cleanupEvalHarnessForTerminalRun(blockedRun, runId, 'blocked run');
          try {
            await cleanupSlotAfterRunFailure(blockedRun.slotId, runId, 'blocked run', () =>
              teardownGateHeldAgentsIfNeeded(blockedRun),
            );
          } catch (resetErr) {
            console.warn(
              `[run-engine] final slot reset failed for blocked run ${blockedRun.slotId}: ${(resetErr as Error).message.slice(0, 200)}`,
            );
          }
        }
        broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
        return;
      }

      if (err instanceof MonitorTerminalError) {
        console.log(
          `[run-engine] run ${runId.slice(0, 8)} step ${stepName} ${err.status} via worker signal: ${err.message}`,
        );
        const completedAtIso = new Date().toISOString();
        const stepEntry = getRun(runId)?.steps.find((s) => s.name === stepName);
        const durationMs = stepEntry?.startedAt
          ? Date.now() - new Date(stepEntry.startedAt).getTime()
          : undefined;
        // Step actually completed — record `done` with full I/O so the run timeline reflects
        // what MONITOR observed, not a fake step failure.
        updateRunStep(runId, stepName, {
          status: 'done',
          completedAt: completedAtIso,
          durationMs,
          inputs: err.stepInputs,
          outputs: err.stepOutputs,
        });
        for (let j = i + 1; j < steps.length; j++) {
          updateRunStep(runId, steps[j], { status: 'skipped' });
        }
        const monitorRun = getRun(runId)!;
        updateRun(runId, {
          status: err.status,
          completedAt: completedAtIso,
          error: err.message,
          metrics: {
            ...monitorRun.metrics,
            outcome: err.outcome,
            durationMs: Date.now() - new Date(monitorRun.createdAt).getTime(),
          },
        });
        if (monitorRun.slotId) {
          await cleanupEvalHarnessForTerminalRun(
            getRun(runId) ?? monitorRun,
            runId,
            `monitor-terminal ${err.status}`,
          );
          try {
            const monitorSlotId = monitorRun.slotId;
            await cleanupSlotAfterRunFailure(
              monitorSlotId,
              runId,
              `monitor-terminal ${err.status}`,
              () => cleanupSlotProcesses(monitorSlotId),
            );
          } catch (resetErr) {
            console.warn(
              `[run-engine] slot reset after monitor-terminal ${err.status} for ${monitorRun.slotId}: ${(resetErr as Error).message.slice(0, 200)}`,
            );
          }
        }
        broadcastFn(Events.RUN_STEP_COMPLETED, { runId, step: stepName });
        broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
        return;
      }

      console.error(`[run-engine] run ${runId.slice(0, 8)} step ${stepName} failed: ${msg}`);

      // Stale loop — a replay started a new generation, don't overwrite its state
      if (getRunGeneration(runId) !== myGen) {
        console.log(
          `[run-engine] run ${runId.slice(0, 8)} — stale loop in catch (gen ${myGen}), not marking failed`,
        );
        return;
      }

      // Persist partial I/O even on failure — valuable for debugging and fine-tuning
      const partialIO = stepPartialIO.get(runId);
      stepPartialIO.delete(runId);
      const failedCommand = (err as any).failedCommand as string | undefined;
      const failedLogPath = (err as any).failedLogPath as string | undefined;
      const failedPhase = (err as any).failedPhase as string | undefined;
      const relatedLogs = (err as any).relatedLogs as string[] | undefined;
      const failureOutputs = {
        ...partialIO?.outputs,
        ...(failedCommand ? { failedCommand } : {}),
        ...(failedLogPath ? { failedLogPath } : {}),
        ...(failedPhase ? { failedPhase } : {}),
        ...(relatedLogs?.length ? { relatedLogs } : {}),
      };
      updateRunStep(runId, stepName, {
        status: 'failed',
        detail: msg,
        inputs: partialIO?.inputs,
        outputs: failureOutputs,
      });
      // Skip remaining steps
      for (let j = i + 1; j < steps.length; j++) {
        updateRunStep(runId, steps[j], { status: 'skipped' });
      }

      const failedRun = getRun(runId)!;

      await cleanupEvalHarnessForTerminalRun(failedRun, runId, `${stepName} failure`);

      // Handle slot on pre-worker failure (prepare/dispatch/write-task).
      // A refused claim is the one exception: this run never owned the slot
      // (an in-flight release or rival claim does), so resetting it here
      // would clear the actual owner's lifecycle fence mid-teardown.
      const claimRefused = isSlotClaimRefusedError(err);
      if (claimRefused && failedRun.slotId) {
        console.log(
          `[run-engine] slot ${failedRun.slotId} left untouched after refused claim (${stepName})`,
        );
      }
      if (
        !claimRefused &&
        failedRun.slotId &&
        (stepName === S.PREPARE ||
          stepName === S.DISPATCH ||
          stepName === S.WRITE_TASK ||
          stepName === S.FIND_SLOT)
      ) {
        try {
          const failedSlotId = failedRun.slotId;
          // Stale processes left by failed prepare (browser, webpack, launcher)
          // are killed behind the cleanup fence, owner-only.
          await cleanupSlotAfterRunFailure(
            failedSlotId,
            runId,
            `${stepName} failure`,
            stepName === S.PREPARE ? () => cleanupSlotProcesses(failedSlotId) : undefined,
          );
        } catch (err) {
          // The run has already failed; reset/cleanup errors are surfaced in
          // logs but should not hide the original pipeline failure.
          console.warn(
            `[run-engine] slot reset after ${stepName} failure failed for ${failedRun.slotId}: ${(err as Error).message.slice(0, 200)}`,
          );
        }
      }

      updateRun(runId, {
        status: 'failed',
        error: msg,
        completedAt: new Date().toISOString(),
        metrics: {
          ...failedRun.metrics,
          outcome: 'failure',
          durationMs: Date.now() - new Date(failedRun.createdAt).getTime(),
        },
      });

      // Safety net: always reset slot fully when a run terminates.
      // Individual steps may already handle this, but if they don't (or throw
      // before reaching their cleanup), this prevents stale busy/held state.
      // EXCEPT after a refused claim: this run never owned the slot, and the
      // reset would reopen it mid-teardown for the release that does.
      if (failedRun.slotId && !claimRefused) {
        try {
          await cleanupSlotAfterRunFailure(failedRun.slotId, runId, 'terminal safety net', () =>
            teardownGateHeldAgentsIfNeeded(failedRun),
          );
        } catch (err) {
          // The run failure has already been recorded; surface reset failure
          // without replacing the root-cause error shown to the operator.
          console.warn(
            `[run-engine] final slot reset failed for ${failedRun.slotId}: ${(err as Error).message.slice(0, 200)}`,
          );
        }
      }

      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
      return;
    }
  }

  // All steps completed
  const finalRun = getRun(runId);
  if (
    finalRun &&
    finalRun.status !== 'cancelled' &&
    finalRun.status !== 'failed' &&
    finalRun.status !== 'blocked'
  ) {
    const durationMs = Date.now() - new Date(finalRun.createdAt).getTime();
    updateRun(runId, {
      status: 'done',
      completedAt: new Date().toISOString(),
      metrics: { ...finalRun.metrics, outcome: 'success', durationMs },
    });
    broadcastFn(Events.RUN_COMPLETED, { run: getRun(runId) });
  }
}

// ─── Cancel a running engine ───

export function cancelRunEngine(runId: string): void {
  const controller = activeMonitors.get(runId);
  if (controller) controller.abort();
}

// ─── Recover active runs on startup ───

const PUBLICATION_REVIEW_RECOVERY_POLL_MS = 10_000;
const PUBLICATION_REVIEW_RECOVERY_MAX_POLL_MS = 5 * 60_000;
const PUBLICATION_REVIEW_RECOVERY_MAX_DURATION_MS = 6 * 60 * 60_000;
const PUBLICATION_REVIEW_RECOVERY_MAX_FAILURES = 8;
const publicationReviewRecoveryWatchers = new Map<
  string,
  {
    cleanup: () => void;
    replayPending: boolean;
  }
>();

async function replayHumanGateForRecovery(runId: string): Promise<void> {
  // replay-step.ts imports this module (startRun), so import lazily.
  const { runReplayStep } = await import('../methods/run/replay-step.js');
  await runReplayStep(
    { runId, stepName: S.HUMAN_GATE, triggeredBy: 'auto-recovery' },
    (event, payload) => broadcastFn(event, payload),
  );
}

function rearmPublicationReviewRecovery(
  run: Run,
  options?: { replayPending?: boolean },
): (() => void) | undefined {
  if (!run.slotId || !isPublicationReviewRecoveryHeld(run)) return undefined;

  const existing = publicationReviewRecoveryWatchers.get(run.id);
  if (existing) {
    if (options?.replayPending) existing.replayPending = true;
    return existing.cleanup;
  }

  let settled = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const storedRecovery = run.engineState?.publishGate?.reviewRecovery;
  // Only a still-active watcher belongs to this episode. Recovered and
  // operator-required records describe a closed episode; a later interrupted
  // reviewer must get a fresh budget and clock.
  const previousRecovery = storedRecovery?.status === 'watching' ? storedRecovery : undefined;
  let attempts = previousRecovery?.attempts ?? 0;
  let failures = 0;
  const persistedStartedAtMs = Date.parse(previousRecovery?.startedAt ?? '');
  const startedAtMs = Number.isFinite(persistedStartedAtMs) ? persistedStartedAtMs : Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const state = {
    replayPending: options?.replayPending ?? false,
    cleanup: (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (publicationReviewRecoveryWatchers.get(run.id) === state) {
        publicationReviewRecoveryWatchers.delete(run.id);
      }
    },
  };

  const persistRecovery = (
    latest: Run,
    status: 'watching' | 'recovered' | 'operator-required',
    fields: { nextRetryAt?: string; lastError?: string } = {},
  ): void => {
    const current = getRun(latest.id) ?? latest;
    updateRun(current.id, {
      engineState: {
        ...current.engineState,
        publishGate: {
          ...current.engineState?.publishGate,
          reviewRecovery: {
            status,
            attempts,
            startedAt,
            updatedAt: new Date().toISOString(),
            ...fields,
          },
        },
      },
    });
  };

  const clearRecovery = (latest: Run): void => {
    const current = getRun(latest.id) ?? latest;
    updateRun(current.id, {
      engineState: {
        ...current.engineState,
        publishGate: {
          ...current.engineState?.publishGate,
          reviewRecovery: undefined,
        },
      },
    });
  };

  const schedule = (latest: Run): void => {
    const delayMs = Math.min(
      PUBLICATION_REVIEW_RECOVERY_MAX_POLL_MS,
      PUBLICATION_REVIEW_RECOVERY_POLL_MS * 2 ** Math.min(attempts, 5),
    );
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    persistRecovery(latest, 'watching', { nextRetryAt });
    timer = setTimeout(() => {
      void poll();
    }, delayMs);
    timer.unref();
  };

  const poll = async (): Promise<void> => {
    if (settled || inFlight) return;
    const latest = getRun(run.id);
    if (!latest) {
      state.cleanup();
      return;
    }
    if (!latest.slotId || !isPublicationReviewRecoveryHeld(latest)) {
      clearRecovery(latest);
      state.cleanup();
      return;
    }
    if (!state.replayPending && !hasRecoverablePublicationReviewer(latest)) {
      clearRecovery(latest);
      state.cleanup();
      return;
    }

    inFlight = true;
    attempts += 1;
    try {
      if (Date.now() - startedAtMs >= PUBLICATION_REVIEW_RECOVERY_MAX_DURATION_MS) {
        persistRecovery(latest, 'operator-required', {
          lastError: 'Publication reviewer recovery exceeded the six-hour watcher budget.',
        });
        state.cleanup();
        return;
      }
      if (!state.replayPending) {
        const recoveryResult = await recoverInflightPublicationReviews(latest.id, latest.slotId);
        if (
          recoveryResult.recoveredIds.length === 0 &&
          recoveryResult.terminalErrors.length === 0
        ) {
          failures = 0;
          schedule(latest);
          return;
        }
        state.replayPending = recoveryResult.recoveredIds.length > 0;
        if (recoveryResult.terminalErrors.length > 0) {
          const terminalMessage = recoveryResult.terminalErrors
            .map((error) => error.message)
            .join('; ');
          if (state.replayPending) {
            try {
              await replayHumanGateForRecovery(latest.id);
            } catch (error) {
              persistRecovery(getRun(latest.id) ?? latest, 'operator-required', {
                lastError:
                  `${terminalMessage}; gate replay failed: ${(error as Error).message}`.slice(
                    0,
                    200,
                  ),
              });
              state.cleanup();
              return;
            }
          }
          persistRecovery(getRun(latest.id) ?? latest, 'operator-required', {
            lastError: terminalMessage.slice(0, 200),
          });
          state.cleanup();
          return;
        }
      }
      await replayHumanGateForRecovery(latest.id);
      persistRecovery(getRun(latest.id) ?? latest, 'recovered');
      state.cleanup();
    } catch (err) {
      failures += 1;
      const message = (err as Error).message.slice(0, 200);
      console.warn(
        `[run-engine] run ${run.id.slice(0, 8)} — publication-review recovery poll failed: ${message}`,
      );
      if (failures >= PUBLICATION_REVIEW_RECOVERY_MAX_FAILURES) {
        persistRecovery(getRun(latest.id) ?? latest, 'operator-required', {
          lastError: message,
        });
        state.cleanup();
        return;
      }
      schedule(getRun(latest.id) ?? latest);
    } finally {
      inFlight = false;
    }
  };

  publicationReviewRecoveryWatchers.set(run.id, state);
  schedule(run);
  return state.cleanup;
}

function buildRecoveryDeps(): RunRecoveryCollaborators {
  return {
    listRuns,
    loadFleetStatus,
    getRun,
    updateRun,
    updateRunStep,
    broadcast: (event: string, payload: unknown) => broadcastFn(event, payload),
    copyWorkerArtifacts,
    readReviewArtifacts,
    loadProjectVarsOrNull,
    scanArtifacts,
    readTaskArtifactText,
    setPrHealthOverlay,
    buildCIWatchChainedRunParams,
    createRun,
    applyChainedRunEngineFlags,
    startRun,
    reconstructStepOutputs,
    loadSlotVars,
    getProjectFieldRaw,
    expandTemplate,
    clearStalePrepareProcess,
    expandHook,
    execOnSlot,
    getProjectField,
    setRunFlags,
    resetSlot,
    quarantineLeakedRun,
    reconcileRunAgentRuntime: async (run) => {
      await reconcileRunAgentRuntime(run);
    },
    rearmHandoffAutoRecovery: (run) =>
      rearmInteractiveHandoffAutoRecovery(run, async (runId, decisionId, actionId) => {
        // methods/run.ts imports this module, so a static import here would
        // be circular; resolve through the public path lazily instead.
        const { runResolveDecision } = await import('../methods/run.js');
        await runResolveDecision({ runId, decisionId, actionId }, (event, payload) =>
          broadcastFn(event, payload),
        );
      }),
    rearmPublicationReviewRecovery,
    recoverInflightPublicationReviews,
    replayHumanGate: replayHumanGateForRecovery,
  };
}

export async function recoverActiveRuns(): Promise<void> {
  await recoverActiveRunsImpl(buildRecoveryDeps());
}

export function startOrphanReconciler(): void {
  startOrphanReconcilerImpl(buildRecoveryDeps());
}

// ─── Step execution ───

interface StepIO {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

async function executeStep(runId: string, step: string): Promise<StepIO> {
  const run = getRun(runId)!;

  switch (step) {
    case S.GRADE:
      return executeGradeStep(runId, run, stepPartialIO);

    case S.WRITE_TASK:
      return executeWriteTaskStep(runId, run, { broadcastFn, stepPartialIO });

    case S.FIND_SLOT:
      return executeFindSlotStep(runId, run, {
        broadcastFn,
        buildDispatchPreviewParamsForRun,
        createEngineDecision,
        determineSelectionMethodForRun,
        handleCollisionDecision,
        requiresCollisionPrecheck,
        resolveRunDispatchRunnerModel,
        setRunFlags,
      });
    case S.PREPARE:
      return executePrepareStep(runId, {
        activeMonitors,
        broadcastFn,
        getRunFlags,
        normalizeEvalReplayForTaskWrite,
        stepPartialIO,
      });
    case S.DISPATCH:
      return executeDispatchStep(runId, {
        stepPartialIO,
        blockedRunError: (message, reason) => new BlockedRunError(message, reason),
      });
    case S.MONITOR:
      return executeMonitorStep(runId, {
        activeMonitors,
        blockedRunError: (message, reason) => new BlockedRunError(message, reason),
        broadcastFn,
        createEngineDecision,
        executeNoChangeGate,
        executePublishGateReviewPlan,
        executeReadyGate,
        executeReviewGate,
        getDiffStat,
        interactiveLightweightSkipOutputs,
        isHumanGateEnabled,
        monitorTerminalError: (args) => new MonitorTerminalError(args),
        refreshRunLinks,
        stepPartialIO,
      });
    case S.SELF_REVIEW:
      return executeSelfReviewStep(runId, {
        activeMonitors,
        blockedRunError: (message, reason) => new BlockedRunError(message, reason),
        broadcastFn,
        createEngineDecision,
        executeNoChangeGate,
        executePublishGateReviewPlan,
        executeReadyGate,
        executeReviewGate,
        getDiffStat,
        interactiveLightweightSkipOutputs,
        isHumanGateEnabled,
        monitorTerminalError: (args) => new MonitorTerminalError(args),
        refreshRunLinks,
        stepPartialIO,
      });
    case S.HUMAN_GATE:
      return executeHumanGateStep(runId, {
        activeMonitors,
        blockedRunError: (message, reason) => new BlockedRunError(message, reason),
        broadcastFn,
        createEngineDecision,
        executeNoChangeGate,
        executePublishGateReviewPlan,
        executeReadyGate,
        executeReviewGate,
        getDiffStat,
        interactiveLightweightSkipOutputs,
        isHumanGateEnabled,
        monitorTerminalError: (args) => new MonitorTerminalError(args),
        refreshRunLinks,
        stepPartialIO,
      });
    case S.COMPLETE:
      return executeCompleteStep(runId, {
        activeMonitors,
        blockedRunError: (message, reason) => new BlockedRunError(message, reason),
        broadcastFn,
        createEngineDecision,
        executeNoChangeGate,
        executePublishGateReviewPlan,
        executeReadyGate,
        executeReviewGate,
        getDiffStat,
        interactiveLightweightSkipOutputs,
        isHumanGateEnabled,
        monitorTerminalError: (args) => new MonitorTerminalError(args),
        refreshRunLinks,
        stepPartialIO,
      });
    case S.CI_WATCH:
      return executeCIWatchStep(runId, {
        activeMonitors,
        applyChainedRunEngineFlags,
        broadcastFn,
        buildCIWatchChainedRunParams,
        hasValidPrNumber,
        loadProjectVarsOrNull,
        resolveCIWatchTerminalPatch,
        startRun,
      });
    case S.FINALIZE:
      return executeFinalizeStep(runId, {
        blockedRunError: (message, reason) => new BlockedRunError(message, reason),
        broadcastFn,
        latestResolvedHumanGateDecision,
        loadProjectVarsOrNull,
        readPreparedPackage,
        refreshRunLinks,
        stepPartialIO,
      });
    default:
      throw new Error(`Unknown step: ${step}`);
  }
}

// ─── Slot process cleanup on prepare failure ───

export async function cleanupSlotProcesses(slotId: string): Promise<void> {
  const vars = await loadSlotVars(slotId);
  let runtimeDir = '.agent';
  try {
    const pv = await loadProjectVars(vars.projectName);
    runtimeDir = pv.runtimeDir;
  } catch (err) {
    // Legacy project metadata may be absent while failure cleanup still needs
    // to target the default agent runtime directory.
    console.warn(
      `[run-engine] cleanup using default runtime dir for ${slotId}: ${(err as Error).message.slice(0, 200)}`,
    );
  }
  const rd = `${vars.remoteRepo}/${runtimeDir}`;
  const port = vars.resourceVars.port;

  // Kill the exact prepare process group only while a live member still carries
  // the opaque scope exported by this prepare. Nohup descendants retain both
  // identities after the wrapper exits; a recycled PGID cannot satisfy the
  // scope check.
  const killCmd = [
    'set -u',
    `identityfile="${rd}/preflight.identity";`,
    `if [ -f "$identityfile" ]; then`,
    `  identity=$(cat "$identityfile" 2>/dev/null || true);`,
    `  tab=$(printf '\t');`,
    `  pgid=""; sentinel=""; scope=""; rest="";`,
    `  case "$identity" in *"$tab"*) pgid=\${identity%%"$tab"*}; rest=\${identity#*"$tab"} ;; esac;`,
    `  case "$rest" in *"$tab"*) sentinel=\${rest%%"$tab"*}; scope=\${rest#*"$tab"} ;; esac;`,
    `  valid=false;`,
    `  case "$pgid:$sentinel" in *[!0-9:]*|:*|*:) ;; *) case "$scope" in ''|*[!0-9a-f]*|*"$tab"*) ;; *) if [ "$pgid" -gt 1 ] && [ "$sentinel" -gt 1 ] && [ "\${#scope}" -eq 32 ]; then valid=true; fi ;; esac ;; esac;`,
    `  matched=false;`,
    `  if $valid; then`,
    `    live_pgid=$(ps -o pgid= -p "$sentinel" 2>/dev/null | tr -d '[:space:]');`,
    `    marker_ok=false; scope_ok=false;`,
    `    if [ "$live_pgid" = "$pgid" ]; then`,
    `      sentinel_command=$(ps -ww -p "$sentinel" -o command= 2>/dev/null || true);`,
    `      if printf '%s\n' "$sentinel_command" | tr ' ' '\n' | grep -Fxq -- 'farmslot-prepare-scope'; then marker_ok=true; fi;`,
    `      if printf '%s\n' "$sentinel_command" | tr ' ' '\n' | grep -Fxq -- "$scope"; then scope_ok=true; fi;`,
    `    fi;`,
    `    if $marker_ok && $scope_ok; then matched=true; fi;`,
    `  fi;`,
    `  if $matched && kill -TERM -- "-$pgid" 2>/dev/null; then echo "killed verified preflight group ($pgid)"; fi;`,
    `fi`,
    // Kill later process-specific identities when their pidfiles exist.
    `for pf in launcher.pid browser.pid chromium.pid webpack.pid; do`,
    `  pidfile="${rd}/$pf";`,
    `  if [ -f "$pidfile" ]; then`,
    `    p=$(cat "$pidfile");`,
    `    if [ -n "$p" ] && kill "$p" 2>/dev/null; then echo "killed $pf ($p)"; fi;`,
    `  fi;`,
    `done`,
    // Kill webpack by dev-server port
    port
      ? `if pids=$(lsof -ti ":${port}" 2>/dev/null); then if [ -n "$pids" ]; then kill $pids; fi; else rc=$?; if [ "$rc" -ne 1 ]; then exit "$rc"; fi; fi`
      : ':',
    // Clean pid files
    `rm -f "${rd}/browser.pid" "${rd}/chromium.pid" "${rd}/extension.id" "${rd}/launcher.pid" "${rd}/preflight.identity" "${rd}/preflight.pgid" "${rd}/webpack.pid"`,
  ].join('\n');

  const result = await execOnSlot(vars, killCmd);
  if (result.exitCode !== 0) {
    throw new Error(
      `slot cleanup failed for ${slotId}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
    );
  }
  console.log(`[run-engine] cleaned up slot processes for ${slotId}`);
}

// ─── Helpers ───

function findStartStep(run: Run, steps: string[]): number {
  for (let i = 0; i < steps.length; i++) {
    const step = run.steps.find((s) => s.name === steps[i]);
    if (!step || step.status !== 'done') return i;
  }
  return steps.length;
}

const DEFAULT_HUMAN_GATES: Record<string, boolean> = {
  'review-pr': true,
  'fix-bug': true,
  dev: false,
  'pr-complete': false,
};

async function isHumanGateEnabled(
  project: string,
  flowType: FlowType,
  mode?: 'interactive' | 'autonomous' | 'validation',
): Promise<boolean> {
  if (flowType === 'fix-bug') return true;
  if (flowType === 'dev' && mode === 'autonomous') return true;
  if (mode === 'autonomous') return false;
  if (mode === 'interactive') return true;
  if (mode === 'validation') return true;
  const pv = await loadProjectVarsOrNull(project, 'human gate config');
  const gates = (pv?.projectJson as any)?.human_gates;
  if (gates && typeof gates[flowType] === 'boolean') return gates[flowType];
  return DEFAULT_HUMAN_GATES[flowType] ?? false;
}

async function executeNoChangeGate(runId: string): Promise<void> {
  const current = getRun(runId)!;
  const disposition = current.metrics.disposition;
  if (!isNoCodeTerminalDisposition(disposition)) return;
  const noChangeDisposition: 'already_fixed' | 'not_reproducible' = disposition;

  const report = await readWorkerReport(runId);
  const monitorSignal = current.steps.find((step) => step.name === S.MONITOR)?.outputs
    ?.workerSignal as { reason?: string } | undefined;
  let artifactManifest: EvidenceManifestEntry[] | undefined;
  if (current.taskFile) {
    try {
      artifactManifest = await scanArtifacts(path.dirname(current.taskFile));
    } catch (err) {
      console.warn(
        `[run-engine] no-change gate artifact scan failed for ${runId.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }

  const { desc, payload } = buildNoChangeGateInputs({
    disposition: noChangeDisposition,
    ticketOrPr: current.ticketOrPr,
    monitorReason: monitorSignal?.reason,
    evidence: current.metrics.terminalEvidence,
    report,
    artifactManifest,
  });

  const actionId = await createEngineDecision(
    runId,
    'no_change',
    desc,
    [
      {
        id: 'accept-no-change',
        label: `Accept — ${noChangeDispositionLabel(noChangeDisposition)}`,
        style: 'primary',
      },
      { id: 'reject-retry', label: 'Reject — retry reproduction', style: 'secondary' },
      { id: 'mark-blocked', label: 'Mark blocked — insufficient evidence', style: 'danger' },
    ],
    payload,
  );

  if (actionId === 'accept-no-change') {
    updateRunStep(runId, S.HUMAN_GATE, {
      detail: `Accepted no-change result: ${noChangeDisposition}`,
    });
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — accepted no-change disposition ${noChangeDisposition}`,
    );
    return;
  }

  const latest = getRun(runId)!;
  const message = noChangeRejectionMessage(
    actionId as 'reject-retry' | 'mark-blocked',
    current.ticketOrPr,
  );
  updateRun(runId, {
    status: 'blocked',
    error: message,
    metrics: { ...latest.metrics, outcome: 'partial' },
  });
  throw new BlockedRunError(message, actionId);
}

function payloadKind(payload: RunDecisionPayload | null | undefined): string {
  if (!payload || typeof payload !== 'object') return 'unknown';
  const kind = (payload as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind.trim() ? kind : 'unknown';
}

/** Reconstruct step outputs from decision data when recovery skips a step. */
function reconstructStepOutputs(run: Run, stepName: string): Record<string, unknown> | null {
  if (stepName === S.HUMAN_GATE) {
    const gateDecision = run.decisions.find(
      (d) => (d.type === 'engine_human_gate' || d.type === 'engine_review_posting') && d.resolvedAt,
    );
    if (!gateDecision) return null;
    const waitMs =
      gateDecision.resolvedAt && gateDecision.createdAt
        ? new Date(gateDecision.resolvedAt).getTime() - new Date(gateDecision.createdAt).getTime()
        : undefined;
    return {
      resolvedAction: gateDecision.resolvedAction ?? null,
      waitDurationMs: waitMs,
      gatePayloadSummary: payloadKind(gateDecision.payload),
      recoveredFromRestart: true,
    };
  }
  return null;
}
