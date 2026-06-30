import type { Run } from '@farmslot/protocol';

function latestStepTimestamp(run: Run): number | null {
  let latest: number | null = null;
  for (const step of run.steps ?? []) {
    for (const ts of [step.completedAt, step.startedAt]) {
      if (!ts) continue;
      const t = Date.parse(ts);
      if (Number.isFinite(t) && (latest == null || t > latest)) latest = t;
    }
  }
  return latest;
}

/**
 * Single source for a run's elapsed time. Prefers an explicitly recorded
 * `metrics.durationMs`, then `createdAt`→`completedAt` for terminal runs, and for
 * still-running / blocked-at-gate runs falls back to `createdAt`→furthest step
 * progress (e.g. time to reach the human gate) so surfaces show real elapsed time
 * instead of a dash. Returns null when no usable timestamp pair is resolvable.
 */
export function runDurationMs(run: Run): number | null {
  if (run.metrics.durationMs && run.metrics.durationMs > 0) return run.metrics.durationMs;
  const start = run.createdAt ? Date.parse(run.createdAt) : NaN;
  if (!Number.isFinite(start)) return null;
  const end = run.completedAt ? Date.parse(run.completedAt) : latestStepTimestamp(run);
  if (end == null || !Number.isFinite(end) || end < start) return null;
  return end - start;
}
