import type { Run } from '@farmslot/protocol';

export const BEFORE_WORKER_LAUNCH = 'before-worker-launch';
export const WORKER_LAUNCH = 'worker-launch';

/** A replay or retained reservation must not start a fresh pre-worker scope. */
export function workerMayHaveStarted(run: Run): boolean {
  return Boolean(
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
    ),
  );
}

/** Only a positively pre-launch failure may give up replay's prepared checkout. */
export function failedBeforeWorkerLaunch(run: Run): boolean {
  if (run.status !== 'failed') return false;
  const failed = run.steps.find((step) => step.status === 'failed');
  return Boolean(
    failed &&
    ((['find-slot', 'write-task', 'prepare'].includes(failed.name) && !workerMayHaveStarted(run)) ||
      (failed.name === 'dispatch' && failed.outputs?.failedPhase === BEFORE_WORKER_LAUNCH)),
  );
}
