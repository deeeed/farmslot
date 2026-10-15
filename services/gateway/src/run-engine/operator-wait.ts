import type { WorkerSignal } from '@farmslot/protocol';

/** The signal writer retains closed intervals so an offline resume loses no wait time. */
export function operatorWaitDurationMs(
  signal: WorkerSignal,
  startedAt: number,
  now: number,
): number {
  const duration = (since: string, until: number) =>
    Math.max(0, Math.min(now, until) - Math.max(startedAt, Date.parse(since)));
  return (
    (signal.operatorWaitIntervals ?? []).reduce(
      (total, interval) => total + duration(interval.since, Date.parse(interval.until)),
      0,
    ) + (signal.waitingForOperator ? duration(signal.waitingForOperator.since, now) : 0)
  );
}
