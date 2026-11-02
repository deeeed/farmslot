import type { AgentContext, Run } from '@farmslot/protocol';

import { RunnerExecutionError } from '../runners/runner-execution-error.js';

import { checkAgentLive, probeWorkerSignalForRun } from './run-monitor.js';

export interface WorkerExitReaders {
  signal: typeof probeWorkerSignalForRun;
  liveness: typeof checkAgentLive;
}

/** Recorded states in which an agent may still be running. A blocked agent already keeps its slot. */
const MAYBE_RUNNING: ReadonlySet<AgentContext['status']> = new Set([
  'launching',
  'working',
  'waiting',
]);

/**
 * The run's agents that may still be running without positive evidence that they finished or
 * are gone. Evidence is a terminal signal file, a terminal turn the runner itself reported (a
 * dropped model connection is not one), or the agent's process or pane missing. A step error
 * alone never is: tearing down on it killed ce1c5583's live Pi worker (F328). Failure paths
 * stop agents only when this is empty.
 */
export async function agentsWithoutExitEvidence(
  run: Run,
  readers: Partial<WorkerExitReaders> = {},
): Promise<string[]> {
  const source: WorkerExitReaders = {
    signal: probeWorkerSignalForRun,
    liveness: checkAgentLive,
    ...readers,
  };
  const running: string[] = [];
  for (const context of run.agentContexts ?? []) {
    const slotId = context.slotId ?? run.slotId;
    if (!slotId || !MAYBE_RUNNING.has(context.status)) continue;
    if (!(await agentExited(run, slotId, context, source))) running.push(context.id);
  }
  return running;
}

async function agentExited(
  run: Run,
  slotId: string,
  context: AgentContext,
  source: WorkerExitReaders,
): Promise<boolean> {
  try {
    const probe = await source.signal(run.id, slotId, context);
    // A terminal signal the artifact contract refuses still says the worker stopped.
    if (
      probe.ok ||
      probe.code === 'artifact_contract' ||
      probe.code === 'terminal_contract_infrastructure'
    )
      return true;
  } catch {
    // An unreadable signal is no evidence either way; liveness decides.
  }
  try {
    const status = await source.liveness(
      slotId,
      context.runner ?? run.metrics.runner,
      run.id,
      context.role,
      context.id,
    );
    return status === 'idle' || status === 'no-tmux';
  } catch (error) {
    return error instanceof RunnerExecutionError;
  }
}
