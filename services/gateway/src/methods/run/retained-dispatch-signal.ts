import path from 'node:path';

import {
  type AgentContext,
  primaryRoleForFlow,
  type Run,
  type WorkerSignal,
} from '@farmslot/protocol';

import type { SlotVars } from '../../core/config.js';
import { resolveExactTmuxWindowPane } from '../../core/tmux.js';
import { resolveWorkerTaskDir } from '../../review/templates.js';
import {
  probeRunnerDescendantPid,
  verifyExactLiveRunnerSessionBinding,
} from '../../runners/session-process.js';
import { normalizeWorkerSignal, parseStrictIsoMs } from '../../tasks/worker-signals.js';

interface RetainedDispatchSignalDeps {
  pane: typeof resolveExactTmuxWindowPane;
  probe: typeof probeRunnerDescendantPid;
  binding: typeof verifyExactLiveRunnerSessionBinding;
  taskDir: typeof resolveWorkerTaskDir;
}

/** A refused retry cannot abandon a proven original worker for an unrelated newer dispatch time. */
export async function retainedDispatchSignal(
  run: Run,
  context: AgentContext,
  vars: SlotVars,
  signal: unknown,
  deps: RetainedDispatchSignalDeps = {
    pane: resolveExactTmuxWindowPane,
    probe: probeRunnerDescendantPid,
    binding: verifyExactLiveRunnerSessionBinding,
    taskDir: resolveWorkerTaskDir,
  },
): Promise<WorkerSignal | null> {
  const dispatch = run.steps.find((step) => step.name === 'dispatch');
  const failedAt = parseStrictIsoMs(dispatch?.startedAt);
  const attemptAt = parseStrictIsoMs(context.attemptStartedAt);
  if (
    run.transport === 'native' ||
    context.nativeSession ||
    context.role !== primaryRoleForFlow(run.flowType) ||
    dispatch?.status !== 'failed' ||
    run.engineState?.taskInit?.status !== 'initialized' ||
    run.engineState.taskInit.taskFile !== run.taskFile ||
    context.runId !== run.id ||
    context.slotId !== run.slotId
  )
    return null;

  const runner = context.runner ?? run.metrics.runner;
  if (!runner || !context.target?.paneId)
    throw new Error(
      'Retained worker liveness is unconfirmed; its runner or pane identity is incomplete.',
    );
  const pane = await deps.pane(vars, context.target.paneId);
  if (!pane)
    throw new Error('Retained worker liveness is unconfirmed; its recorded pane is unavailable.');
  const process = await deps.probe(vars, pane.panePid, runner);
  if (process.state === 'absent') return null;
  if (process.state === 'unknown')
    throw new Error(
      'Retained worker liveness is unconfirmed; preserve its task and retry inspection.',
    );
  if (!context.runnerSessionId || !context.runnerSessionPath)
    throw new Error(
      'Retained worker identity is incomplete; preserve the live worker and restore its recorded session.',
    );
  if (
    !context.taskFile ||
    !context.signalFile ||
    !context.signalAttemptId ||
    failedAt === null ||
    attemptAt === null ||
    attemptAt >= failedAt
  )
    throw new Error(
      'Retained worker original attempt identity is incomplete or unconfirmed; preserve the live worker.',
    );
  const directory = await deps.taskDir(vars, run.project, run.taskFile);
  if (
    !directory ||
    path.posix.resolve(vars.remoteRepo, context.taskFile) !==
      path.posix.resolve(vars.remoteRepo, directory, 'TASK.md') ||
    path.posix.resolve(vars.remoteRepo, context.signalFile) !==
      path.posix.resolve(vars.remoteRepo, directory, 'SIGNAL.json')
  )
    throw new Error(
      'Retained worker does not belong to the current task; preserve its files and recover the intended task explicitly.',
    );
  const binding = await deps.binding(vars, runner, {
    paneId: pane.paneId,
    slotId: vars.slotId,
    runnerPid: process.pid,
    expectedSessionId: context.runnerSessionId,
    expectedSessionPath: context.runnerSessionPath,
  });
  if (!binding.ok) throw new Error(`Retained worker identity is unconfirmed: ${binding.reason}`);
  const normalized = normalizeWorkerSignal(signal);
  const signalAt = normalized.ok ? parseStrictIsoMs(normalized.signal.timestamp) : null;
  if (
    !normalized.ok ||
    normalized.signal.attemptId !== context.signalAttemptId ||
    signalAt === null ||
    signalAt < attemptAt
  )
    throw new Error(
      'Retained worker signal does not match its original task attempt; preserve the worker and retry after its signal is restored.',
    );
  return normalized.signal;
}
