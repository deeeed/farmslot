const LONG_TASK_MS = 50;

export interface JavaScriptTaskSample {
  completedAtEpochMs: number;
  durationMs: number;
}

export interface JavaScriptTaskMetricSummary {
  longestTaskMs?: number;
  longTaskCount?: number;
  longTaskPercent?: number;
  p50TaskMs?: number;
  p95TaskMs?: number;
  p99TaskMs?: number;
  taskCount: number;
  totalTaskTimeMs?: number;
}

export function summarizeJavaScriptTasks(
  samples: readonly JavaScriptTaskSample[],
): JavaScriptTaskMetricSummary {
  const durations = samples
    .map((sample) => sample.durationMs)
    .filter((duration) => Number.isFinite(duration) && duration > 0)
    .sort((first, second) => first - second);
  if (durations.length === 0) return { taskCount: 0 };

  const longTaskCount = durations.filter((duration) => duration >= LONG_TASK_MS).length;
  return {
    longestTaskMs: round(durations.at(-1) ?? 0),
    longTaskCount,
    longTaskPercent: round((longTaskCount / durations.length) * 100),
    p50TaskMs: round(percentile(durations, 0.5)),
    p95TaskMs: round(percentile(durations, 0.95)),
    p99TaskMs: round(percentile(durations, 0.99)),
    taskCount: durations.length,
    totalTaskTimeMs: round(durations.reduce((total, duration) => total + duration, 0)),
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 1) return sorted[0] ?? 0;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
