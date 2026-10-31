import { PipelineSteps, type Run } from '@farmslot/protocol';

/** Monitor output that carries the reason a blind eval worker blocked its own first output. */
export const EVAL_WORKER_BLOCKED_OUTPUT = 'evalWorkerBlocked';

/** The reason a blind eval worker gave when it blocked its own first output. */
export function evalWorkerBlockedReason(run: Pick<Run, 'steps'>): string | undefined {
  const reason = run.steps.find(({ name }) => name === PipelineSteps.MONITOR)?.outputs?.[
    EVAL_WORKER_BLOCKED_OUTPUT
  ];
  return typeof reason === 'string' ? reason : undefined;
}

/** A run's outcome when it ends done: a blind eval worker that blocked itself finished its trial, not its task. */
export function completedRunOutcome(run: Pick<Run, 'steps'>): 'partial' | 'success' {
  return evalWorkerBlockedReason(run) ? 'partial' : 'success';
}
