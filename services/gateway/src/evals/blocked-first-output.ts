import { PipelineSteps, type Run, type RunMetrics } from '@farmslot/protocol';

/** Monitor output that carries the reason a blind eval worker blocked its own first output. */
export const EVAL_WORKER_BLOCKED_OUTPUT = 'evalWorkerBlocked';

/** The reason a blind eval worker gave when it blocked its own first output. */
export function evalWorkerBlockedReason(run: Pick<Run, 'steps'>): string | undefined {
  const reason = run.steps.find(({ name }) => name === PipelineSteps.MONITOR)?.outputs?.[
    EVAL_WORKER_BLOCKED_OUTPUT
  ];
  return typeof reason === 'string' ? reason : undefined;
}

/** A finished eval trial without a judge verdict is not a successful task. */
export function completedRunOutcome(
  run: Pick<Run, 'steps'> & Partial<Pick<Run, 'engineState'>>,
): NonNullable<RunMetrics['outcome']> {
  if (evalWorkerBlockedReason(run)) return 'partial';
  const review = run.steps.find(({ name }) => name === PipelineSteps.REVIEW)?.outputs;
  if (run.engineState?.evalExperiment && review?.skipped === true) return 'unjudged';
  return 'success';
}
