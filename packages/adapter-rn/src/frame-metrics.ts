export interface FrameSample {
  cadenceInterval?: boolean;
  completedAtEpochMs: number;
  durationMs: number;
  frameBudgetMs?: number;
  overBudget?: boolean;
  startedAtEpochMs?: number;
}

export interface FrameMetricSummary {
  activeFps?: number;
  cadenceGapCount?: number;
  fpsIntervalCount?: number;
  fpsUnavailableReason?:
    | 'insufficient_active_frames'
    | 'refresh_rate_unavailable'
    | 'unclassified_cadence_gap';
  frameBudgetMs?: number;
  frameCount: number;
  longestCadenceGapMs?: number;
  longestFrameMs?: number;
  overBudgetFrameCount?: number;
  overBudgetFramePercent?: number;
  p50FrameMs?: number;
  p95FrameMs?: number;
  p99FrameMs?: number;
  refreshRateHz?: number;
}

const MIN_ACTIVE_INTERVALS = 5;

export function summarizeFrames(samples: readonly FrameSample[]): FrameMetricSummary {
  const allValidSamples = samples.filter(
    (sample) => Number.isFinite(sample.durationMs) && sample.durationMs > 0,
  );
  const frameBudgetMs = commonFrameBudget(allValidSamples);
  const cadenceSamples =
    allValidSamples.length > 0 &&
    allValidSamples.every((sample) => sample.cadenceInterval === true);
  const cadenceGaps =
    cadenceSamples && frameBudgetMs
      ? allValidSamples.filter((sample) => sample.durationMs > frameBudgetMs * 3.01)
      : [];
  const validSamples =
    cadenceGaps.length > 0
      ? allValidSamples.filter((sample) => sample.durationMs <= (frameBudgetMs ?? 0) * 3.01)
      : allValidSamples;
  const durations = validSamples
    .map((sample) => sample.durationMs)
    .sort((first, second) => first - second);
  if (durations.length === 0) {
    return {
      fpsUnavailableReason: frameBudgetMs
        ? 'insufficient_active_frames'
        : 'refresh_rate_unavailable',
      ...(cadenceGaps.length > 0
        ? {
            cadenceGapCount: cadenceGaps.length,
            longestCadenceGapMs: round(Math.max(...cadenceGaps.map((sample) => sample.durationMs))),
          }
        : {}),
      ...(frameBudgetMs
        ? {
            frameBudgetMs: round(frameBudgetMs),
            refreshRateHz: round(1000 / frameBudgetMs),
          }
        : {}),
      frameCount: 0,
    };
  }

  const frameBudgetOutcomes = validSamples
    .map((sample) => sample.overBudget)
    .filter((value): value is boolean => value !== undefined);
  const missedFrameBudgetCount = frameBudgetOutcomes.filter(Boolean).length;
  const activeIntervals = frameBudgetMs
    ? activeRenderingIntervals(validSamples, frameBudgetMs)
    : [];
  const activeElapsedMs = activeIntervals.reduce((total, interval) => total + interval, 0);
  const hasActiveFps =
    cadenceGaps.length === 0 &&
    activeIntervals.length >= MIN_ACTIVE_INTERVALS &&
    activeElapsedMs > 0;
  const refreshRateHz = frameBudgetMs ? 1000 / frameBudgetMs : undefined;

  return {
    ...(hasActiveFps
      ? {
          activeFps: round(
            Math.min(
              refreshRateHz ?? Number.POSITIVE_INFINITY,
              (activeIntervals.length * 1000) / activeElapsedMs,
            ),
          ),
          fpsIntervalCount: activeIntervals.length,
        }
      : {
          fpsUnavailableReason: frameBudgetMs
            ? cadenceGaps.length > 0
              ? ('unclassified_cadence_gap' as const)
              : ('insufficient_active_frames' as const)
            : ('refresh_rate_unavailable' as const),
        }),
    ...(cadenceGaps.length > 0
      ? {
          cadenceGapCount: cadenceGaps.length,
          longestCadenceGapMs: round(Math.max(...cadenceGaps.map((sample) => sample.durationMs))),
        }
      : {}),
    ...(frameBudgetMs
      ? {
          frameBudgetMs: round(frameBudgetMs),
          refreshRateHz: round(1000 / frameBudgetMs),
        }
      : {}),
    frameCount: durations.length,
    ...(frameBudgetOutcomes.length === validSamples.length
      ? {
          overBudgetFrameCount: missedFrameBudgetCount,
          overBudgetFramePercent: round((missedFrameBudgetCount / validSamples.length) * 100),
        }
      : {}),
    longestFrameMs: round(durations.at(-1) ?? 0),
    p50FrameMs: round(percentile(durations, 0.5)),
    p95FrameMs: round(percentile(durations, 0.95)),
    p99FrameMs: round(percentile(durations, 0.99)),
  };
}

function commonFrameBudget(samples: readonly FrameSample[]): number | undefined {
  const budgets = samples
    .map((sample) => sample.frameBudgetMs)
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0)
    .sort((first, second) => first - second);
  return budgets.length > 0 ? percentile(budgets, 0.5) : undefined;
}

function activeRenderingIntervals(
  samples: readonly FrameSample[],
  frameBudgetMs: number,
): number[] {
  if (samples.every((sample) => sample.cadenceInterval === true)) {
    return samples
      .map((sample) => sample.durationMs)
      .filter(
        (durationMs) =>
          Number.isFinite(durationMs) && durationMs > 0 && durationMs <= frameBudgetMs * 3.01,
      );
  }
  const ordered = [...samples]
    .map((sample) => ({
      ...sample,
      startedAtEpochMs: sample.startedAtEpochMs ?? sample.completedAtEpochMs - sample.durationMs,
    }))
    .sort((first, second) => first.startedAtEpochMs - second.startedAtEpochMs);
  const intervals: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;
    const interval = current.startedAtEpochMs - previous.startedAtEpochMs;
    if (!Number.isFinite(interval) || interval <= 0) continue;
    const continuous = interval <= frameBudgetMs * 3.01;
    const explainedBySlowFrame =
      Math.max(previous.durationMs, current.durationMs) >= interval - frameBudgetMs * 1.01;
    if (continuous || explainedBySlowFrame) intervals.push(interval);
  }
  return intervals;
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
