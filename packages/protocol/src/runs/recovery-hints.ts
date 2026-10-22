import type { Run, RunStep } from '../contracts/runs.js';

/** The held worker step, shared by recovery controls and the gateway. */
export function blockedWorkerRecoveryStep(run: Pick<Run, 'status' | 'steps'>): RunStep | null {
  if (run.status !== 'blocked') return null;
  const review = run.steps.find((step) => step.name === 'review');
  if (
    review?.status === 'done' &&
    review.outputs?.verdict === 'blocked' &&
    review.outputs.feedbackSent === true
  )
    return review;
  const monitor = run.steps.find((step) => step.name === 'monitor');
  const signal = monitor?.outputs?.workerSignal;
  return monitor?.status === 'done' &&
    signal &&
    typeof signal === 'object' &&
    'status' in signal &&
    signal.status === 'blocked'
    ? monitor
    : null;
}

export function runRecoveryHints(run: Pick<Run, 'status' | 'decisions'>): string[] {
  if (!['blocked', 'paused', 'failed'].includes(run.status)) return [];
  return run.decisions
    .filter((decision) => !decision.resolvedAt)
    .map(
      (decision) =>
        `Pending decision ${decision.id}. Actions: ${decision.actions.map((action) => action.id).join(', ')}. ${decision.actions.map((action) => `farmslot decision resolve ${decision.id} ${action.id}`).join('; ')}`,
    );
}
