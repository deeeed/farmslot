import {
  Events,
  type Run,
  type RunCancelParams,
  type RunCancelResult,
  type RunForceCompleteParams,
  type RunForceCompleteResult,
  type RunPauseParams,
  type RunPauseResult,
  type RunResumeParams,
  type RunResumeResult,
} from '@farmslot/protocol';

import { selectAgentContext } from '../../agents/contexts.js';
import { execOnSlot } from '../../core/exec.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../../core/tmux.js';
import {
  bumpRunGeneration,
  cancelRunEngine,
  type RunEngineStepStartAcknowledgement,
  startRunWithStepAcknowledgement,
} from '../../run-engine/orchestrator.js';
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
import { getRun, updateRun } from '../../runs/store.js';

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

export async function runForceComplete(
  params: RunForceCompleteParams,
  emit: Emit,
): Promise<RunForceCompleteResult> {
  return withRunTransition(params.runId, () => runForceCompleteTransitionLocked(params, emit));
}

export async function runForceCompleteTransitionLocked(
  params: RunForceCompleteParams,
  emit: Emit,
): Promise<RunForceCompleteResult> {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);
  assertNotMachineParkManaged(existing);

  const completableStatuses = new Set(['ci-watching']);
  if (!completableStatuses.has(existing.status)) {
    throw new Error(`Run ${params.runId} cannot be force-completed in status: ${existing.status}`);
  }

  // Abort the CI monitor's AbortController — the run-engine pipeline then
  // completes naturally: CI_WATCH returns outcome='aborted' → no chaining →
  // retrospective + slot release → FINALIZE → done
  cancelRunEngine(params.runId);

  const run = getRun(params.runId)!;
  emit(Events.RUN_UPDATED, { run });
  console.log(`[run] force-completing run ${params.runId.slice(0, 8)} (was ${existing.status})`);
  return { run };
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
  status: 'monitoring' | 'ci-watching';
  acknowledgedAt: string;
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
}

const DEFAULT_RUN_RESUME_DEPS: RunResumeTransitionDependencies = {
  nudgeMonitor: nudgeResumedMonitor,
  redrive: startRunWithStepAcknowledgement,
};

export async function runResumeTransitionLocked(
  params: RunResumeParams,
  emit: Emit,
  options: RunResumeTransitionOptions = {},
  deps: RunResumeTransitionDependencies = DEFAULT_RUN_RESUME_DEPS,
): Promise<RunResumeAcknowledgement> {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);

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

function assertNotMachineParkManaged(run: Run): void {
  if (run.park && run.park.phase !== 'restored' && run.park.phase !== 'cancelled') {
    throw new Error(
      `Run ${run.id} is managed by machine pause phase '${run.park.phase}'; use machine restore or cancel`,
    );
  }
}
