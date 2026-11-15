import type { Run } from '@farmslot/protocol';

export const BEFORE_WORKER_LAUNCH = 'before-worker-launch';
export const WORKER_LAUNCH = 'worker-launch';

/** Only a positively pre-launch failure may give up replay's prepared checkout. */
export function failedBeforeWorkerLaunch(run: Run): boolean {
  if (run.status !== 'failed') return false;
  if (
    run.metrics.runnerSessionId ||
    run.metrics.runnerSessionPath ||
    run.agentContexts?.some(
      (context) =>
        context.startedAt ||
        context.promptDeliveryStartedAt ||
        context.runnerSessionId ||
        context.runnerSessionPath ||
        context.nativeSession ||
        context.nativeSessionOwner,
    )
  )
    return false;
  const failed = run.steps.find((step) => step.status === 'failed');
  return Boolean(
    failed &&
    (['find-slot', 'write-task', 'prepare'].includes(failed.name) ||
      (failed.name === 'dispatch' && failed.outputs?.failedPhase === BEFORE_WORKER_LAUNCH)),
  );
}
