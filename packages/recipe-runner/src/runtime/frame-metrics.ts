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
  maxGapMs = frameBudgetMs * 3.01,
): number[] {
  if (samples.every((sample) => sample.cadenceInterval === true)) {
    return samples
      .map((sample) => sample.durationMs)
      .filter(
        (durationMs) => Number.isFinite(durationMs) && durationMs > 0 && durationMs <= maxGapMs,
      );
  }
  const ordered = orderedByStart(samples);
  const intervals: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;
    const interval = current.startedAtEpochMs - previous.startedAtEpochMs;
    if (!Number.isFinite(interval) || interval <= 0) continue;
    if (continuousRendering(previous, current, interval, frameBudgetMs, maxGapMs)) {
      intervals.push(interval);
    }
  }
  return intervals;
}

// Two consecutive frames are one stretch of rendering when the second starts
// within `maxGapMs`, or when a slow frame between them explains the gap.
function continuousRendering(
  previous: FrameSample,
  current: FrameSample,
  interval: number,
  frameBudgetMs: number,
  maxGapMs: number,
): boolean {
  return (
    interval <= maxGapMs ||
    Math.max(previous.durationMs, current.durationMs) >= interval - frameBudgetMs * 1.01
  );
}

function orderedByStart(
  samples: readonly FrameSample[],
): Array<FrameSample & { startedAtEpochMs: number }> {
  return [...samples]
    .map((sample) => ({
      ...sample,
      startedAtEpochMs: sample.startedAtEpochMs ?? sample.completedAtEpochMs - sample.durationMs,
    }))
    .sort((first, second) => first.startedAtEpochMs - second.startedAtEpochMs);
}

export interface LowestWindowedFpsOptions {
  /** How much continuous rendering each window covers. */
  windowMs: number;
  /** The largest gap between frame starts that still counts as rendering; 3.01 frame budgets by default. */
  maxGapMs?: number;
}

/**
 * The lowest frame rate over any `windowMs` of continuous rendering, clamped
 * to the refresh rate as `activeFps` is. A window starts at a frame and counts
 * when the stretch of rendering it starts in lasts the whole `windowMs`,
 * however few frames that is, so steady slow frames read as a low rate. A
 * short burst or an idle screen has no such window: undefined.
 */
export function lowestWindowedFps(
  samples: readonly FrameSample[],
  { windowMs, maxGapMs }: LowestWindowedFpsOptions,
): number | undefined {
  const ordered = orderedByStart(
    samples.filter((sample) => Number.isFinite(sample.durationMs) && sample.durationMs > 0),
  );
  const frameBudgetMs = commonFrameBudget(ordered);
  if (!frameBudgetMs) return undefined;
  const gapMs = maxGapMs ?? frameBudgetMs * 3.01;
  const stretches: Array<typeof ordered> = [];
  for (const sample of ordered) {
    const stretch = stretches.at(-1);
    const previous = stretch?.at(-1);
    const interval = previous ? sample.startedAtEpochMs - previous.startedAtEpochMs : Infinity;
    if (
      stretch &&
      previous &&
      continuousRendering(previous, sample, interval, frameBudgetMs, gapMs)
    ) {
      stretch.push(sample);
    } else {
      stretches.push([sample]);
    }
  }
  let lowest: number | undefined;
  for (const stretch of stretches) {
    const lastStart = stretch.at(-1)?.startedAtEpochMs ?? 0;
    for (let start = 0; start < stretch.length; start += 1) {
      const from = stretch[start]?.startedAtEpochMs ?? 0;
      if (from + windowMs > lastStart) break;
      let end = start + 1;
      while ((stretch[end + 1]?.startedAtEpochMs ?? Infinity) <= from + windowMs) end += 1;
      const elapsed = (stretch[end]?.startedAtEpochMs ?? from) - from;
      if (elapsed <= 0) continue;
      const window = stretch.slice(start, end + 1);
      const refreshRateHz = 1000 / (commonFrameBudget(window) ?? frameBudgetMs);
      const fps = Math.min(refreshRateHz, ((end - start) * 1000) / elapsed);
      lowest = Math.min(lowest ?? fps, fps);
    }
  }
  return lowest === undefined ? undefined : round(lowest);
}

/**
 * The display's frame budget from frame start times (ms): the 10th-percentile
 * interval between 3.5 and 40 ms, snapped to a whole refresh rate from 24 to
 * 240 Hz. Undefined with fewer than five such intervals.
 */
export function estimateRefreshBudgetMs(frameStartsMs: readonly number[]): number | undefined {
  const cadenceMs: number[] = [];
  for (let index = 1; index < frameStartsMs.length; index += 1) {
    const previous = frameStartsMs[index - 1];
    const current = frameStartsMs[index];
    if (previous === undefined || current === undefined) continue;
    const intervalMs = current - previous;
    if (intervalMs >= 3.5 && intervalMs <= 40) cadenceMs.push(intervalMs);
  }
  if (cadenceMs.length < 5) return undefined;
  cadenceMs.sort((first, second) => first - second);
  const observedBudgetMs = percentile(cadenceMs, 0.1);
  const refreshRateHz = Math.round(1000 / observedBudgetMs);
  return refreshRateHz >= 24 && refreshRateHz <= 240 ? 1000 / refreshRateHz : undefined;
}

/** Linear-interpolated quantile of an ascending list (0 when it is empty). */
export function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 1) return sorted[0] ?? 0;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

/** Rounded to three decimals, as every frame metric is reported. */
export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
