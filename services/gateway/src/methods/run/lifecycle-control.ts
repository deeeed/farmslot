import {
  Events,
  MachineParkEligibilityCodes,
  type Run,
  type RunCancelParams,
  type RunCancelResult,
  type RunForceCompleteParams,
  type RunForceCompleteResult,
  type RunPauseParams,
  type RunPauseResult,
  type RunResumeParams,
  type RunResumeResult,
  type RunStatus,
} from '@farmslot/protocol';

import { selectAgentContext } from '../../agents/contexts.js';
import { markBacklogRunObserved } from '../../backlog/store.js';
import { execOnSlot } from '../../core/exec.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../../core/tmux.js';
import { hasValidPrNumber } from '../../run-engine/gate-policy.js';
import {
  bumpRunGeneration,
  cancelRunEngine,
  type RunEngineStepStartAcknowledgement,
  startRunWithStepAcknowledgement,
} from '../../run-engine/orchestrator.js';
import { isSlotFreedByPark } from '../../run-engine/park-slot-binding.js';
import {
  cancelTransitionDeps,
  defaultCancelCollaborators,
} from '../../run-lifecycle/cancel-transition.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { routeRunTransition } from '../../run-lifecycle/transition-router.js';
import {
  isRunnerPaneRetired,
  normalizeRunner,
  runnerContinueCommand,
  runnerPaneLooksIdle,
  sendRunnerInstructionSafely,
} from '../../runners/registry.js';
import {
  resolveRunRetainedSessionBinding,
  retainedSessionSendOption,
} from '../../runners/session-process.js';
import { getRun, updateRun, updateRunStep } from '../../runs/store.js';
import { schedulerTick } from '../../work-graph/store.js';

type Emit = (event: string, payload: unknown) => void;

/**
 * Takes no emitter: ADR-053 makes the transition own both store propagation and
 * global publication. Passing one in is what made a cancel's reach depend on
 * which caller invoked it.
 */
export async function runCancel(params: RunCancelParams): Promise<RunCancelResult> {
  return withRunTransition(params.runId, () => runCancelTransitionLocked(params));
}

export async function runCancelTransitionLocked(params: RunCancelParams): Promise<RunCancelResult> {
  const { machineParkingService } = await import('../../machine-parking/service.js');
  const parkedCancel = await machineParkingService.prepareRunCancel(params.runId);
  const { run, effects } = await routeRunTransition(
    {
      kind: 'cancel',
      runId: params.runId,
      actor: 'operator',
      ...(params.reason ? { reason: params.reason } : {}),
    },
    cancelTransitionDeps(defaultCancelCollaborators()),
  );

  // A cancel can reach its terminal state while an advisory effect failed. Returning
  // only `run` reported unqualified success for a partially-applied cancel; the
  // outcomes travel with the result so callers and operators can see the gap.
  const failed = effects.filter((effect) => effect.status === 'failed');
  // The router publishes `cancelled` before the after-effects finish. The mutation's
  // write-ahead marker blocks archive/delete until backlog settlement clears it, so
  // a failed settle always leaves a live repair source.
  let settled = run;
  if (failed.length > 0) {
    // The backlog projection is repaired from this durable marker on next load,
    // so a failed settle self-heals instead of waiting for someone to notice.
    if (failed.some((effect) => effect.name === 'backlog-settle')) {
      // A marker-clear write can itself fail after the backlog write succeeds. Re-set
      // it on any reported settle failure so restart reconciliation remains conservative.
      settled = getRun(run.id)
        ? updateRun(run.id, { backlogReconcilePending: true })
        : { ...run, backlogReconcilePending: true };
    }
    console.warn(
      `[run] cancel ${run.id.slice(0, 8)} applied with ${failed.length} failed effect(s): ${failed
        .map((effect) => `${effect.name} (${effect.detail ?? 'no detail'})`)
        .join('; ')}`,
    );
  }

  if (parkedCancel) {
    await machineParkingService.finalizeRunCancel(params.runId, effects);
    settled = getRun(params.runId) ?? settled;
  }

  return { run: settled, effects };
}

export interface RunForceCompleteTransitionDependencies {
  cancelEngine(runId: string): void;
  bumpGeneration(runId: string): number;
  attachPrNumber(runId: string, prNumber: number): Promise<void>;
  publish(run: Run): Promise<Run>;
  releaseSlot(run: Run): Promise<{ released: boolean }>;
}

const DEFAULT_RUN_FORCE_COMPLETE_DEPS: RunForceCompleteTransitionDependencies = {
  cancelEngine: cancelRunEngine,
  bumpGeneration: bumpRunGeneration,
  attachPrNumber: attachForceCompletePrNumber,
  publish: publishForceCompletedRun,
  releaseSlot: releaseForceCompletedSlot,
};

export async function runForceComplete(
  params: RunForceCompleteParams,
  emit: Emit,
): Promise<RunForceCompleteResult> {
  return withRunTransition(params.runId, () => runForceCompleteTransitionLocked(params, emit));
}

export async function runForceCompleteTransitionLocked(
  params: RunForceCompleteParams,
  emit: Emit,
  deps: RunForceCompleteTransitionDependencies = DEFAULT_RUN_FORCE_COMPLETE_DEPS,
): Promise<RunForceCompleteResult> {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);
  assertNotMachineParkManaged(existing);
  const originalStatus = existing.status;

  const completableStatuses = new Set(['ci-watching', 'failed', 'blocked']);
  // Only the blocked path falls back to the run's own PR: it is the one status
  // that requires a number, and making the caller resend a value the run already
  // owns is what forced the CLI to repeat `--pr`. Every other status keeps the
  // caller-supplied value, so a stored `0` sentinel (see `hasValidPrNumber`)
  // cannot fail an otherwise valid completion. `0` is never a usable fallback.
  const linkedPrNumber = hasValidPrNumber(existing) ? (existing.prNumber ?? null) : null;
  const effectivePrNumber =
    params.prNumber ?? (originalStatus === 'blocked' ? linkedPrNumber : null);
  const repairsStaleForceCompletion =
    existing.engineState?.operatorForceCompleted === true && effectivePrNumber != null;
  if (!completableStatuses.has(originalStatus) && !repairsStaleForceCompletion) {
    throw new Error(`Run ${params.runId} cannot be force-completed in status: ${originalStatus}`);
  }
  if (originalStatus === 'blocked' && effectivePrNumber == null) {
    throw new Error(
      `Run ${params.runId} is blocked; force-complete requires a published PR number`,
    );
  }
  if (effectivePrNumber != null) assertPositivePrNumber(effectivePrNumber);

  if (originalStatus === 'ci-watching') {
    // Abort first so an await on PR attach cannot race the watch into a new
    // status while this transition still reports ci-watching.
    deps.cancelEngine(params.runId);
    if (params.prNumber != null) {
      try {
        await deps.attachPrNumber(params.runId, params.prNumber);
      } catch (err) {
        // Advisory: the watch is already aborting. The PR number can be
        // retried via rehydrate if refresh failed.
        console.warn(
          `[run] force-complete PR attach failed for ${params.runId.slice(0, 8)}: ${(err as Error).message}`,
        );
      }
    }
    // Abort the CI monitor's AbortController — the run-engine pipeline then
    // completes naturally: CI_WATCH returns outcome='aborted' → no chaining →
    // retrospective + slot release → FINALIZE → done
    const run = getRun(params.runId)!;
    emit(Events.RUN_UPDATED, { run });
    console.log(`[run] force-completing run ${params.runId.slice(0, 8)} (was ${existing.status})`);
    return { run };
  }

  // Terminal override path: fence recovery synchronously before any await. Replay and
  // auto-recovery key off `failed` + generation; yielding for link refresh
  // first lets them revive the run after this transition has committed done.
  deps.cancelEngine(params.runId);
  deps.bumpGeneration(params.runId);
  if (repairsStaleForceCompletion) {
    const current = getRun(params.runId)!;
    const { operatorForceCompleted: _operatorForceCompleted, ...engineState } =
      current.engineState ?? {};
    updateRun(params.runId, { engineState });
  }
  const reason = `operator force-completed a ${originalStatus} run`;
  for (const step of existing.steps) {
    if (step.status === 'done' || step.status === 'skipped') continue;
    // Rewrite failed (and any other unfinished) steps: the operator is
    // declaring the run done despite the recorded failure.
    updateRunStep(params.runId, step.name, {
      status: 'skipped',
      completedAt:
        step.status === 'failed'
          ? (step.completedAt ?? existing.completedAt ?? new Date().toISOString())
          : new Date().toISOString(),
      ...(step.durationMs != null ? { durationMs: step.durationMs } : {}),
      detail: `Skipped: ${reason}`,
      outputs: { ...(step.outputs ?? {}), skipped: true, reason, source: 'operator' },
    });
  }
  const current = getRun(params.runId)!;
  const completedAt = new Date().toISOString();
  const decisions = current.decisions.map((decision) => {
    if (decision.resolvedAt || decision.type === 'retrospective') return decision;
    return {
      ...decision,
      resolvedAt: completedAt,
      resolvedAction: 'superseded',
      context: { ...decision.context, supersededBy: 'operator-force-complete' },
    };
  });
  const run = updateRun(params.runId, {
    status: 'done',
    completedAt,
    error: undefined,
    metrics: { ...current.metrics, outcome: 'success' },
    backlogReconcilePending: true,
    recoveryProposal: {
      status: 'idle',
      generation: current.engineState?.generation ?? 0,
    },
    engineState: { ...(current.engineState ?? {}), operatorForceCompleted: true },
    decisions,
    ...(params.prNumber != null ? { prNumber: params.prNumber } : {}),
    // Failed runs already emitted a failure row. Clear the marker so the
    // append-only sink records this override; query last-record-wins.
    analyticsEmittedAt: undefined,
  });
  if (params.prNumber != null) {
    try {
      await deps.attachPrNumber(params.runId, params.prNumber);
    } catch (err) {
      // Advisory: the PR number is already on the done write. Stale links
      // refresh on the next ticketData change.
      console.warn(
        `[run] force-complete PR attach failed for ${params.runId.slice(0, 8)}: ${(err as Error).message}`,
      );
    }
  }
  // Publish terminal state first (ADR-053 cancel order): UI and observers must
  // see `done` before slow slot teardown. Slot-release failures stay advisory
  // effects because the operator-owned done write already landed and cannot be
  // retried.
  let settled = getRun(params.runId) ?? run;
  try {
    settled = await deps.publish(settled);
  } catch (err) {
    // Advisory after-effects: the operator-owned done write already landed.
    // Failing the RPC would block retry because status is already `done`.
    console.warn(
      `[run] force-complete publication failed for ${params.runId.slice(0, 8)}: ${(err as Error).message}`,
    );
    settled = getRun(params.runId) ?? settled;
  }
  const effects = await collectForceCompleteSlotReleaseEffect(settled, deps);
  console.log(`[run] force-completed ${originalStatus} run ${params.runId.slice(0, 8)}`);
  return { run: getRun(params.runId) ?? settled, effects };
}

async function collectForceCompleteSlotReleaseEffect(
  run: Run,
  deps: RunForceCompleteTransitionDependencies,
): Promise<RunForceCompleteResult['effects']> {
  if (!run.slotId) return [{ name: 'slot-release', status: 'skipped', detail: 'no slot bound' }];
  try {
    const { released } = await deps.releaseSlot(run);
    return released
      ? [{ name: 'slot-release', status: 'ok' }]
      : [{ name: 'slot-release', status: 'skipped', detail: 'already released or not owned' }];
  } catch (err) {
    const detail = (err as Error).message;
    console.warn(`[run] force-complete slot release failed for ${run.id.slice(0, 8)}: ${detail}`);
    return [{ name: 'slot-release', status: 'failed', detail }];
  }
}

function assertPositivePrNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`prNumber must be a positive integer (got ${String(prNumber)})`);
  }
}

async function attachForceCompletePrNumber(runId: string, prNumber: number): Promise<void> {
  updateRun(runId, { prNumber });
  try {
    const { refreshRunLinks } = await import('../../run-engine/run-links.js');
    await refreshRunLinks(runId);
  } catch (err) {
    // Advisory: the PR number is stored. Stale links refresh on the next
    // ticketData change; do not fail the hatch after the number has landed.
    console.warn(
      `[run] force-complete could not refresh PR links for ${runId.slice(0, 8)}: ${(err as Error).message}`,
    );
  }
}

async function releaseForceCompletedSlot(run: Run): Promise<{ released: boolean }> {
  if (!run.slotId) return { released: false };
  const { slotRelease } = await import('../slot.js');
  const { broadcastEvent } = await import('../../server.js');
  const result = await slotRelease(
    { slotId: run.slotId, keepWork: true, expectedRunId: run.id },
    broadcastEvent,
  );
  if (result.released) {
    const { loadFleetStatus } = await import('../../fleet/state.js');
    broadcastEvent(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
  }
  return result;
}

export async function publishForceCompletedRun(run: Run, broadcast?: Emit): Promise<Run> {
  try {
    const emit = broadcast ?? (await import('../../server.js')).broadcastEvent;
    emit(Events.RUN_UPDATED, { run });
    emit(Events.RUN_COMPLETED, { run });
    // Raw broadcastEvent is the WebSocket fan-out only. Terminal observers live
    // on the index.ts wrapper; invoke them so recovery and Co-Pilot close out.
    const { routeEventToAutoRecovery } = await import('../../auto-recovery/watcher.js');
    const { routeEventToObserver } = await import('../../chat/copilot-observer.js');
    routeEventToAutoRecovery(Events.RUN_UPDATED, { run });
    routeEventToObserver(Events.RUN_COMPLETED, { run });
  } catch (err) {
    // Advisory: the store already holds `done`. Other clients may be stale until
    // the next refetch; do not fail the RPC or the operator cannot retry.
    console.warn(
      `[run] force-complete broadcast failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
    );
  }
  try {
    await markBacklogRunObserved(run);
  } catch (err) {
    // Advisory: leave backlogReconcilePending so restart repair can finish.
    // Skip the work-graph tick; it would schedule against unsettled backlog.
    console.warn(
      `[run] force-complete backlog settle failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
    );
    return getRun(run.id) ?? run;
  }
  const settled = getRun(run.id) ?? run;
  if (!settled.workGraphId) return settled;
  try {
    await schedulerTick({ graphId: settled.workGraphId });
  } catch (err) {
    // Advisory: scheduler tick is recovery, not the operator-owned terminal write.
    console.warn(
      `[run] force-complete work-graph tick failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
    );
  }
  return getRun(run.id) ?? settled;
}

export async function runPause(params: RunPauseParams, emit: Emit): Promise<RunPauseResult> {
  return withRunTransition(params.runId, () => runPauseTransitionLocked(params, emit));
}

export interface RunPauseTransitionOptions {
  /** Machine workflow holds the coordinator and owns the active park record. */
  machineParkingPause?: boolean;
}

export async function runPauseTransitionLocked(
  params: RunPauseParams,
  emit: Emit,
  options: RunPauseTransitionOptions = {},
): Promise<RunPauseResult> {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);
  if (!options.machineParkingPause) assertNotMachineParkManaged(existing);

  // A gate park (ADR-054 `free-slot`, amending ADR-038) is its own branch, not a
  // widening of the pausable statuses. The run is ALREADY durably waiting on an
  // operator decision: there is no monitor loop to abort, and moving it to
  // `paused` would clobber the `blocked`/`human-gating` status its pending gate
  // is published under. The park record is the durable hold; the gate stays
  // answerable while the slot is freed.
  if (options.machineParkingPause && isGateParkPause(existing)) {
    console.log(
      `[run] gate-park hold for run ${params.runId.slice(0, 8)} (status ${existing.status} preserved)`,
    );
    return { run: existing };
  }

  // Can only pause runs that are actively monitoring/watching
  const pausableStatuses = new Set(['monitoring', 'ci-watching']);
  if (!pausableStatuses.has(existing.status)) {
    throw new Error(`Run ${params.runId} cannot be paused in status: ${existing.status}`);
  }

  // Abort the active monitor/ci-watch thread (user can Ctrl+C worker manually from terminal)
  cancelRunEngine(params.runId);

  const run = updateRun(params.runId, { status: 'paused' });
  emit(Events.RUN_UPDATED, { run });
  console.log(`[run] paused run ${params.runId.slice(0, 8)} (was ${existing.status})`);
  return { run };
}

export async function runResume(params: RunResumeParams, emit: Emit): Promise<RunResumeResult> {
  const result = await withRunTransition(params.runId, () =>
    runResumeTransitionLocked(params, emit),
  );
  return { run: result.run };
}

export interface RunResumeAcknowledgement {
  run: Run;
  previousGeneration: number;
  generation: number;
  stepName: string;
  /**
   * Where the run ended up. An ordinary resume re-enters its monitor or
   * ci-watch loop; a gate-park restore keeps the status the park preserved, so
   * this is the run's own gate status rather than one of those two.
   */
  status: RunStatus;
  acknowledgedAt: string;
  /**
   * Set only by the gate-park branch: the run was never `paused` and nothing
   * was re-driven, so the generation is unchanged by design. Callers that check
   * an ordinary resume advanced the generation must not apply that rule here.
   */
  gateParkHold?: true;
  /**
   * Set when the gate loop had already exited and restore had to re-present the
   * gate. The generation DOES advance here, unlike `gateParkHold`: there was no
   * live loop left to fence out, and the replay has to take ownership.
   */
  gateParkReplayed?: true;
}

export interface RunResumeTransitionOptions {
  /** Release restore already delivered an exact continuation prompt. */
  suppressMonitorNudge?: boolean;
  /** Machine workflow holds the coordinator and owns the active park record. */
  machineParkingRestore?: boolean;
}

export interface RunResumeTransitionDependencies {
  nudgeMonitor(run: Run, emit: Emit): Promise<void>;
  redrive(runId: string, expectedGeneration: number): Promise<RunEngineStepStartAcknowledgement>;
  /** Re-present a gate whose engine loop exited before the park was restored. */
  replayGate(runId: string, stepName: string): Promise<void>;
}

/**
 * Who a gate replay is attributed to. `operator`, not `auto-recovery`: a
 * machine restore is an operator action, and recording it as auto-recovery
 * would charge the replay against the automatic attempt budget and misreport
 * its provenance in the recovery audit.
 */
export const GATE_PARK_REPLAY_TRIGGER = 'operator' as const;

const DEFAULT_RUN_RESUME_DEPS: RunResumeTransitionDependencies = {
  nudgeMonitor: nudgeResumedMonitor,
  redrive: startRunWithStepAcknowledgement,
  replayGate: async (runId, stepName) => {
    // replay-step imports the orchestrator, so keep this lazy.
    const { runReplayStep } = await import('./replay-step.js');
    await runReplayStep({ runId, stepName, triggeredBy: GATE_PARK_REPLAY_TRIGGER }, () => {});
  },
};

export async function runResumeTransitionLocked(
  params: RunResumeParams,
  emit: Emit,
  options: RunResumeTransitionOptions = {},
  deps: RunResumeTransitionDependencies = DEFAULT_RUN_RESUME_DEPS,
): Promise<RunResumeAcknowledgement> {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);

  if (isSlotFreedByPark(existing)) {
    throw new Error(
      `Run ${params.runId} is gate-parked with its slot freed ` +
        `(${MachineParkEligibilityCodes.freedSlotRestoreUnsupported}); ` +
        'restoring into a freed slot is not supported yet — cancel the run to release its park record',
    );
  }
  // The counterpart to `isGateParkPause` on the pause side, and it has to
  // exist: that branch deliberately never moved the run to `paused` and never
  // aborted an engine loop, so none of the machinery below applies. The run is
  // still sitting at its publication gate with a pending decision; what the
  // park took away was its worker, and `restoreOne` has already reloaded that
  // by the time this runs. So there is nothing to re-drive — settling the
  // record here is what lifts the fence and makes the gate answerable again.
  //
  // Bumping the generation would be actively wrong: the gate's engine loop was
  // never cancelled, and a bump makes live loops bail.
  const gateParkPlan = options.machineParkingRestore ? gateParkRestorePlan(existing) : null;
  if (gateParkPlan?.kind === 'hold') {
    console.log(
      `[run] gate-park restore for run ${params.runId.slice(0, 8)} (status ${existing.status} preserved)`,
    );
    emit(Events.RUN_UPDATED, { run: existing });
    return gateParkResumeAcknowledgement(existing, () => new Date().toISOString())!;
  }
  if (gateParkPlan?.kind === 'replay') {
    // Resolution raced the park: the ready-gate fence threw, the gate step was
    // marked done and the rest skipped, and the loop exited. Re-presenting the
    // gate is the only way this run becomes answerable again — without it the
    // record is admitted by the preview and then stranded here.
    const previousGeneration = existing.engineState?.generation ?? 0;
    console.log(
      `[run] gate-park restore replaying '${gateParkPlan.stepName}' for run ${params.runId.slice(0, 8)} (its gate loop had exited)`,
    );
    await deps.replayGate(params.runId, gateParkPlan.stepName);
    const replayed = getRun(params.runId)!;
    const generation = replayed.engineState?.generation ?? previousGeneration;
    // Bound to the generation the replay took ownership at, so it cannot
    // outlive the gate it was set for: the replay is fire-and-forget, and a
    // bare flag would swallow the operator's choice at some unrelated later
    // wait if this gate never reached a boundary at all.
    if (replayed.resourcePosture?.gateChoice === 'free-slot') {
      updateRun(params.runId, {
        resourcePosture: {
          ...replayed.resourcePosture,
          gateChoiceSuppressedForGeneration: generation,
        },
      });
    }
    if (generation <= previousGeneration) {
      throw new Error(
        `Run ${params.runId} gate replay did not take ownership (generation ${generation})`,
      );
    }
    emit(Events.RUN_UPDATED, { run: replayed });
    return {
      run: replayed,
      previousGeneration,
      generation,
      stepName: gateParkPlan.stepName,
      status: replayed.status,
      acknowledgedAt: new Date().toISOString(),
      gateParkReplayed: true,
    };
  }
  if (existing.status !== 'paused') {
    throw new Error(`Run ${params.runId} is not paused (status=${existing.status})`);
  }
  if (!options.machineParkingRestore) assertNotMachineParkManaged(existing);

  // Find the step that was running when paused
  const currentStep = existing.steps.find((s) => s.status === 'running');

  if (!currentStep) {
    throw new Error(`Run ${params.runId} has no running step to resume`);
  }
  if (currentStep.name !== 'monitor' && currentStep.name !== 'ci-watch') {
    throw new Error(`Run ${params.runId} cannot resume non-idempotent step: ${currentStep.name}`);
  }
  if (
    currentStep.name === 'monitor' &&
    currentStep.outputs?.awaitingOperator === true &&
    currentStep.outputs?.reason === 'interactive-completion-operator-owned'
  ) {
    throw new Error(
      `Run ${params.runId} is waiting for an interactive completion action, not Resume`,
    );
  }
  if (currentStep.name === 'monitor' && !options.suppressMonitorNudge) {
    await deps.nudgeMonitor(existing, emit);
  }

  const status = currentStep.name === 'ci-watch' ? 'ci-watching' : 'monitoring';
  updateRun(params.runId, { status });
  // Take ownership from any stale pre-pause loop still unwinding (e.g. a
  // push-verification wait that saw the abort after this resume): the bumped
  // generation makes the old loop bail instead of racing the new one.
  const previousGeneration = existing.engineState?.generation ?? 0;
  const generation = bumpRunGeneration(params.runId);
  let proof: RunEngineStepStartAcknowledgement;
  try {
    proof = await deps.redrive(params.runId, generation);
  } catch (error) {
    updateRun(params.runId, { status: 'paused' });
    throw error;
  }
  if (
    proof.runId !== params.runId ||
    proof.generation !== generation ||
    proof.stepName !== currentStep.name ||
    proof.status !== status
  ) {
    updateRun(params.runId, { status: 'paused' });
    throw new Error(
      `Run ${params.runId} resume acknowledgement did not match generation ${generation}/${currentStep.name}`,
    );
  }

  const run = getRun(params.runId)!;
  emit(Events.RUN_UPDATED, { run });
  console.log(`[run] resumed run ${params.runId.slice(0, 8)}`);
  return {
    run,
    previousGeneration,
    generation,
    stepName: currentStep.name,
    status,
    acknowledgedAt: proof.acknowledgedAt,
  };
}

async function nudgeResumedMonitor(existing: Run, emit: Emit): Promise<void> {
  if (!existing.slotId) return;
  try {
    const { loadSlotVars } = await import('../../core/config.js');
    const vars = await loadSlotVars(existing.slotId);
    // Preserve the pre-retained-binding resume behavior: a missing or ambiguous
    // context must not prevent the base worker session from being nudged.
    const target = await resolveTmuxSession(existing.slotId, vars);
    const { stdout } = await execOnSlot(
      vars,
      tmuxShellSnippet(`capture-pane -t ${shellQuote(target)} -p -S '-5'`),
    );
    const clean = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[^\x20-\x7E\n❯⏵⏸]/g, '');
    const lines = clean
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const runner = normalizeRunner(existing.metrics.runner);
    const retainedSession = resolveRunRetainedSessionBinding(
      existing,
      selectAgentContext(existing, { role: 'primary' }),
    );
    const nudge = runnerContinueCommand(runner);
    if (nudge && (isRunnerPaneRetired(runner) || runnerPaneLooksIdle(lines, runner))) {
      const sent = await sendRunnerInstructionSafely(
        vars,
        target,
        runner,
        nudge,
        'run-resume',
        undefined,
        {
          recovery: { runId: existing.id, emit },
          ...retainedSessionSendOption(retainedSession),
        },
      );
      console.log(
        `[run] worker idle at prompt — ${sent ? 'submitted' : 'failed to submit'} resume instruction`,
      );
    } else {
      console.log(`[run] worker still active — no nudge needed`);
    }
  } catch (error) {
    console.warn(`[run] resume nudge check failed: ${(error as Error).message}`);
  }
}

/**
 * The acknowledgement a gate-park restore produces, or null when this is an
 * ordinary resume that must go through the paused/monitor path.
 *
 * Pure and exported so the machine-parking test double resumes through the SAME
 * decision the production transition uses. A double that re-implements this is
 * how the resume side and the restore side drifted apart unnoticed: restore was
 * admitted for a gate park while resume still demanded `paused`.
 */
/**
 * How a gate park has to be brought back, or null when this is an ordinary
 * resume that must go through the paused/monitor path.
 *
 * Two shapes, because the park's own gate loop may or may not have survived:
 *
 *   - `hold` — the gate step is still `running`, so the loop is still awaiting
 *     the operator. Nothing needs re-driving and the generation must NOT move:
 *     it is a fencing token, and bumping it makes that live loop bail.
 *   - `replay` — resolution raced the park. The ready-gate fence threw, which
 *     marked the gate step `done` and the rest `skipped`, and the loop exited.
 *     Re-arming the step is not enough on its own: nothing would be driving it,
 *     so the run would sit blocked on a running step forever. The gate has to be
 *     replayed, which is also why an advancing generation is correct HERE — there
 *     is no live loop left to fence out.
 */
export type GateParkRestorePlan =
  | { kind: 'hold'; stepName: string }
  | { kind: 'replay'; stepName: string };

export function gateParkRestorePlan(run: Run): GateParkRestorePlan | null {
  if (!isGateParkPause(run)) return null;
  const running = run.steps.find((step) => step.status === 'running');
  if (running) return { kind: 'hold', stepName: running.name };
  // No running step: the park's record still names the step the run was held
  // on, and that is what has to come back.
  const parkedStep = run.park?.prePauseCurrentStep?.name;
  const recorded = parkedStep ? run.steps.find((step) => step.name === parkedStep) : undefined;
  if (!recorded || (recorded.status !== 'done' && recorded.status !== 'skipped')) {
    throw new Error(
      `Run ${run.id} has no running step and no settled '${parkedStep ?? 'unknown'}' step to restore its gate park onto`,
    );
  }
  return { kind: 'replay', stepName: recorded.name };
}

export function gateParkResumeAcknowledgement(
  run: Run,
  now: () => string,
): RunResumeAcknowledgement | null {
  const plan = gateParkRestorePlan(run);
  if (!plan || plan.kind !== 'hold') return null;
  // Unchanged by design: nothing was re-driven, and the gate's engine loop was
  // never cancelled, so a bump would only make a live loop bail.
  const generation = run.engineState?.generation ?? 0;
  return {
    run,
    previousGeneration: generation,
    generation,
    stepName: plan.stepName,
    status: run.status,
    acknowledgedAt: now(),
    gateParkHold: true,
  };
}

/**
 * A park whose record declares it frees the slot, taken at a publication gate.
 * The record is written before this runs, so the intent is already durable.
 */
function isGateParkPause(run: Run): boolean {
  return run.park?.mode === 'release' && run.park.slotDisposition === 'freed';
}

function assertNotMachineParkManaged(run: Run): void {
  if (run.park && run.park.phase !== 'restored' && run.park.phase !== 'cancelled') {
    throw new Error(
      `Run ${run.id} is managed by machine pause phase '${run.park.phase}'; use machine restore or cancel`,
    );
  }
}
