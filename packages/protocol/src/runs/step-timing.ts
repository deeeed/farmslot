import type { Run, RunStep } from '../contracts/runs.js';

/** Dispatch-queue wait before the run existed: queue item creation to run creation. */
export function runDispatchQueueWaitMs(
  run: Pick<Run, 'queuedAt' | 'createdAt'>,
): number | undefined {
  if (!run.queuedAt) return undefined;
  const ms = Date.parse(run.createdAt) - Date.parse(run.queuedAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/**
 * Time a step spent working: its duration (elapsed while running) minus the
 * waits inside it. The first step's dispatch-queue wait lies before its
 * `startedAt`, so it is not taken out of the duration.
 */
export function runStepExecutionMs(
  run: Pick<Run, 'queuedAt' | 'createdAt' | 'steps'>,
  step: RunStep,
  nowMs = Date.now(),
): number | undefined {
  const spanMs =
    step.durationMs ??
    (step.status === 'running' && step.startedAt ? nowMs - Date.parse(step.startedAt) : NaN);
  if (!Number.isFinite(spanMs)) return undefined;
  const beforeStartMs = run.steps[0]?.name === step.name ? (runDispatchQueueWaitMs(run) ?? 0) : 0;
  return Math.max(0, spanMs - Math.max(0, (step.queuedMs ?? 0) - beforeStartMs));
}
