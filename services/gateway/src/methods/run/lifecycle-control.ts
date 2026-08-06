import {
  Events,
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
import { bumpRunGeneration, cancelRunEngine, startRun } from '../../run-engine/orchestrator.js';
import {
  cancelTransitionDeps,
  defaultCancelCollaborators,
} from '../../run-lifecycle/cancel-transition.js';
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

  return { run: settled, effects };
}

export async function runForceComplete(
  params: RunForceCompleteParams,
  emit: Emit,
): Promise<RunForceCompleteResult> {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);

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
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);

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
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);

  if (existing.status !== 'paused') {
    throw new Error(`Run ${params.runId} is not paused (status=${existing.status})`);
  }

  // Find the step that was running when paused
  const currentStep = existing.steps.find((s) => s.status === 'running');

  // If resuming monitoring, check if worker is idle at prompt and nudge it
  if (currentStep?.name === 'monitor' && existing.slotId) {
    try {
      const { loadSlotVars } = await import('../../core/config.js');
      const vars = await loadSlotVars(existing.slotId);
      // Preserve the pre-retained-binding resume behavior: a missing or ambiguous
      // context must not prevent the base worker session from being nudged.
      const target = await resolveTmuxSession(existing.slotId, vars);
      // Capture last few lines of tmux pane to check for idle prompt
      const { stdout } = await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -t ${shellQuote(target)} -p -S '-5'`),
      );
      // Strip ANSI escape codes and check for Claude Code prompt patterns
      const clean = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[^\x20-\x7E\n❯⏵⏸]/g, '');
      const lines = clean
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const runner = normalizeRunner(existing.metrics.runner);
      const retainedSession = resolveRunRetainedSessionBinding(
        existing,
        selectAgentContext(existing, { role: 'primary' }),
      );
      const nudge = runnerContinueCommand(runner);
      // ADR-032 Phase 3: when the pane is retired for this runner (Claude), skip the pane-idle
      // pre-gate and let the hook-only safe-send own the idle/busy decision. Pane-fallback runners
      // (Codex) and pane-only runners keep the pane gate.
      if (nudge && (isRunnerPaneRetired(runner) || runnerPaneLooksIdle(lines, runner))) {
        // ADR-032 Phase 3: pass the run context so a hook-only degraded hold persists through
        // the ADR-031 intelligence-action audit, not just a console warning.
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
    } catch (err) {
      console.warn(`[run] resume nudge check failed: ${(err as Error).message}`);
    }
  }

  if (currentStep) {
    // Re-mark as running — startRun will pick up from this step
    const status =
      currentStep.name === 'ci-watch' ? ('ci-watching' as const) : ('monitoring' as const);
    updateRun(params.runId, { status });
  }

  // Take ownership from any stale pre-pause loop still unwinding (e.g. a
  // push-verification wait that saw the abort after this resume): the bumped
  // generation makes the old loop bail instead of racing the new one.
  bumpRunGeneration(params.runId);
  // Re-drive the engine (restarts monitor/ci-watch loop)
  startRun(params.runId).catch((err) => {
    console.error(
      `[run-engine] resume failed for ${params.runId.slice(0, 8)}: ${(err as Error).message}`,
    );
  });

  const run = getRun(params.runId)!;
  emit(Events.RUN_UPDATED, { run });
  console.log(`[run] resumed run ${params.runId.slice(0, 8)}`);
  return { run };
}
