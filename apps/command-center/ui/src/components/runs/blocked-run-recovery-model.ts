import type { Run, SlotStatus } from '@farmslot/protocol';

export function blockedWorkerOwnsSlot(
  run: Run,
  slot: Pick<SlotStatus, 'currentRunId' | 'lifecycle' | 'phase'> | undefined,
): boolean {
  return (
    slot?.currentRunId === run.id &&
    (slot.lifecycle === 'busy' || slot.lifecycle === 'held') &&
    slot.phase !== 'releasing'
  );
}

export function isRecoverableBlockedWorkerRun(run: Run): boolean {
  const monitor = run.steps.find((step) => step.name === 'monitor');
  return (
    run.status === 'blocked' &&
    run.metrics.disposition === 'blocked' &&
    !run.decisions.some((decision) => !decision.resolvedAt) &&
    monitor?.status === 'done' &&
    !!monitor.outputs?.workerSignal
  );
}

export function canResumeBlockedWorkerMonitor(run: Run, signal: unknown): boolean {
  if (!isRecoverableBlockedWorkerRun(run) || !signal || typeof signal !== 'object') return false;
  const current = signal as Record<string, unknown>;
  const previous = run.steps.find((step) => step.name === 'monitor')?.outputs?.workerSignal;
  const previousAttemptId =
    previous && typeof previous === 'object' && 'attemptId' in previous
      ? previous.attemptId
      : undefined;
  if (current.status !== 'running' && current.status !== 'done' && current.status !== 'complete')
    return false;
  const previousTimestamp =
    previous && typeof previous === 'object' && 'timestamp' in previous ? previous.timestamp : null;
  if (
    typeof previousTimestamp === 'string' &&
    (!Number.isFinite(Date.parse(previousTimestamp)) ||
      typeof current.timestamp !== 'string' ||
      Date.parse(current.timestamp) <= Date.parse(previousTimestamp))
  )
    return false;
  if (typeof previousAttemptId === 'string' && previousAttemptId.length > 0) {
    return typeof current.attemptId === 'string' && current.attemptId !== previousAttemptId;
  }
  return (
    typeof previousTimestamp === 'string' &&
    typeof current.timestamp === 'string' &&
    Number.isFinite(Date.parse(previousTimestamp)) &&
    Date.parse(current.timestamp) > Date.parse(previousTimestamp)
  );
}
