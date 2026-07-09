import {
  Events,
  isTerminalRunStatus,
  type RunCancelParams,
  type RunCancelResult,
  type RunForceCompleteParams,
  type RunForceCompleteResult,
  type RunPauseParams,
  type RunPauseResult,
  type RunResumeParams,
  type RunResumeResult,
} from '@farmslot/protocol';

import { execOnSlot } from '../../core/exec.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../../core/tmux.js';
import { cancelRunEngine, startRun } from '../../run-engine/orchestrator.js';
import {
  normalizeRunner,
  runnerContinueCommand,
  runnerPaneLooksIdle,
  sendRunnerInstructionSafely,
} from '../../runners/registry.js';
import { getRun, updateRun } from '../../runs/store.js';

type Emit = (event: string, payload: unknown) => void;

export async function runCancel(params: RunCancelParams, emit: Emit): Promise<RunCancelResult> {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);

  if (isTerminalRunStatus(existing.status)) {
    throw new Error(`Run ${params.runId} already in terminal state: ${existing.status}`);
  }

  cancelRunEngine(params.runId);

  const completedAt = new Date().toISOString();
  const run = updateRun(params.runId, {
    status: 'cancelled',
    completedAt,
    error: params.reason ?? 'Cancelled by user',
    steps: existing.steps.map((step) =>
      step.status === 'running' || step.status === 'pending'
        ? { ...step, status: 'skipped', completedAt }
        : step,
    ),
    metrics: { ...existing.metrics, outcome: 'cancelled' },
    agentContexts: [],
  });
  emit(Events.RUN_UPDATED, { run });

  // Release any claimed slot on cancel. Runs can be cancelled from human-gate /
  // blocked review-gate states long after dispatch, and keeping the slot busy
  // strands live validation until someone manually resets it. Do this after
  // publishing the terminal run state so Command Center responds immediately
  // even when tmux/window cleanup is slow.
  if (existing.slotId) {
    try {
      const { loadSlotVars, resetSlot } = await import('../../core/index.js');
      const { killAgentInSession, killAllAgentWindows } = await import('../slot.js');
      const { loadFleetStatus } = await import('../../fleet/state.js');
      const vars = await loadSlotVars(existing.slotId);
      await killAllAgentWindows(vars);
      // After role-scoped windows are gone, clean the base pane as a legacy
      // fallback. Do not infer a role from the flow here: cancelled legacy runs
      // can have stale/null flow metadata while their worker lives elsewhere.
      await killAgentInSession(vars, existing.metrics.runner ?? undefined);
      await resetSlot(existing.slotId, true);
      emit(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
      console.log(`[run] released slot ${existing.slotId} on cancel`);
    } catch (err) {
      console.warn(
        `[run] failed to release slot ${existing.slotId} on cancel: ${(err as Error).message}`,
      );
    }
  }

  // A cancelled dispatch must not strand its work-graph node / backlog item in a
  // running state. Release the backlog↔run link and re-project affected graphs so
  // the node returns to a dispatchable state — the same reconciliation the
  // RUN_DELETED handler runs. Best-effort: the projection also self-heals on the
  // next scheduler tick (a cancelled run no longer drives node status), so a
  // transient failure here is recovered on the next tick, not lost.
  try {
    const { markBacklogRunDeleted } = await import('../../backlog/store.js');
    const { schedulerTick } = await import('../../work-graph/store.js');
    const graphIds = await markBacklogRunDeleted(params.runId);
    for (const graphId of graphIds) await schedulerTick({ graphId });
  } catch (err) {
    console.warn(
      `[run] work-graph reconcile on cancel failed for ${params.runId}: ${(err as Error).message}`,
    );
  }

  return { run };
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
      const session = await resolveTmuxSession(existing.slotId, vars);
      // Capture last few lines of tmux pane to check for idle prompt
      const { stdout } = await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -t ${shellQuote(session)} -p -S '-5'`),
      );
      // Strip ANSI escape codes and check for Claude Code prompt patterns
      const clean = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[^\x20-\x7E\n❯⏵⏸]/g, '');
      const lines = clean
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const runner = normalizeRunner(existing.metrics.runner);
      const nudge = runnerContinueCommand(runner);
      if (nudge && runnerPaneLooksIdle(lines, runner)) {
        const sent = await sendRunnerInstructionSafely(vars, session, runner, nudge, 'run-resume');
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
