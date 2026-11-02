// app.performance_capture on adapter-rn runs. `phase: "start"` opens a named
// window on the device's native frames, `phase: "end"` closes it and writes
// its summary (frames, the lowest sustained FPS, the latency of every press
// inside it, and the window's budget verdict), and `phase: "report"` writes
// one report over every window of the run and fails the node when a window
// broke its budget. Targets are reported, never failed on.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  type ActionExecutionContext,
  type ActionHandler,
  type ActionResult,
  RecipeExecutionError,
} from '@farmslot/recipe-runner';
import {
  type FrameMetricSummary,
  percentile,
  type PerformanceSourceStatus,
  round,
  summarizeFrames,
} from '@farmslot/recipe-runner/runtime/cdp-trace';

import {
  type AndroidDeviceDescription,
  type AndroidFrameSample,
  type AndroidGfxinfoCaptureResult,
  type AndroidGfxinfoPerformanceBackend,
  createAndroidGfxinfoPerformanceBackend,
} from './android-gfxinfo-performance.js';
import { resolveMobileToolPath } from './tool-paths.js';

export const PERFORMANCE_CAPTURE_ACTION = 'app.performance_capture';

const execFileAsync = promisify(execFile);

// Actions whose node is one press: their latency runs from the frame that
// handled the input to the frame that answered it.
const PRESS_ACTIONS = new Set(['ui.press', 'ui.key_press']);
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_SUSTAINED_WINDOW_MS = 500;
// How long after the touch the answering frame is looked for: the window of
// the atrace tab-press measurements (biggest Fabric mount within 600 ms).
const DEFAULT_RESPONSE_WINDOW_MS = 600;
// A mount frame stands out from the touch and animation frames around it
// (about 1 ms of UI-thread work on a Pixel 6; tab mounts measured 9-80 ms):
// at least MOUNT_MIN_MS, and either a whole frame budget of UI-thread work or
// MOUNT_OVER_MEDIAN times the median of the other frames after the touch.
const MOUNT_MIN_MS = 4;
const MOUNT_OVER_MEDIAN = 3;
// A mount up to this many response windows after the touch still answers the
// press (and reads over any press cap) when nothing else answered in the
// window, or when rendering ran on without a pause from the window into it.
const MOUNT_LOOKAHEAD = 2;
// Frames closer than this are one stretch of rendering for sustained FPS, so a
// slow cadence (4 vsyncs at 90 Hz is 22.5 fps) counts against the floor.
const MAX_ACTIVE_GAP_MS = 100;
const MIN_SUSTAINED_INTERVALS = 5;
// The metrics failures name, so a reader knows what was measured.
const PRESS_METRIC = 'gfxinfo input->mount frame';
const FPS_METRIC = 'gfxinfo, lowest 500 ms';

export interface RecipeNodeSpan {
  nodeId: string;
  action: string;
  /** What the node acted on (its test id, selector, text or key), named in failures. */
  target?: string;
  startedAtEpochMs: number;
  endedAtEpochMs?: number;
}

export interface PerformanceBudget {
  /** Fail when the lowest sustained FPS of the window is below this. */
  min_sustained_fps?: number;
  /** Fail when the 95th percentile press latency is above this. */
  max_press_p95_ms?: number;
  /** Fail when any press latency is above this, or a press could not be timed. */
  max_press_ms?: number;
  /** Fail when the window recorded fewer native frames, e.g. a scroll that never rendered. */
  min_frames?: number;
}

/**
 * The reference a failure is compared against, e.g. the default branch on a
 * named build and refresh rate. `label` and the numbers appear in failure
 * messages; the whole object is echoed in the summary.
 */
export interface PerformanceBaseline {
  label: string;
  sustained_fps?: number;
  press_p95_ms?: number;
  press_max_ms?: number;
  /** Native frames the window recorded on the baseline. */
  frames?: number;
  /** Display refresh rate of the baseline; a different measured rate is noted. */
  refresh_hz?: number;
  [key: string]: unknown;
}

export interface PerformanceTargets {
  fps?: number;
  press_ms?: number;
}

export interface PressLatency {
  nodeId: string;
  action: string;
  target?: string;
  /** Input frame start to the end of the frame that answered it; absent when not timed. */
  latencyMs?: number;
  /**
   * `mount`: the first frame after the touch that stood out is the answer.
   * `first-frame`: none stood out, so the press is timed to the first frame
   * after the touch; the new screen did no measurable UI-thread work.
   */
  answer?: 'mount' | 'first-frame';
  /** Why the press has no latency. */
  unmeasuredReason?: string;
}

export interface PerformanceWindowSummary {
  schemaVersion: 1;
  id: string;
  status: PerformanceSourceStatus;
  platform: 'android';
  source: string;
  startedAtEpochMs: number;
  endedAtEpochMs: number;
  durationMs: number;
  frames: FrameMetricSummary;
  /** The lowest active FPS over any `sustainedWindowMs` of the window; absent with too few frames. */
  sustainedFps?: number;
  sustainedWindowMs: number;
  presses: PressLatency[];
  press: PressStats;
  /** The same statistics per press target, e.g. per tab. */
  pressByTarget: Record<string, PressStats>;
  /**
   * `inconclusive` when the capture has a coverage gap (failed polls, frames
   * gfxinfo overwrote): it never passes. An idle window, no frames and no
   * gaps, passes.
   */
  budget?: {
    verdict: 'pass' | 'fail' | 'inconclusive';
    limits: PerformanceBudget;
    failures: string[];
    inconclusive: string[];
  };
  baseline?: PerformanceBaseline;
  targets?: {
    fps?: { target: number; sustainedFps?: number; activeFps?: number; met: boolean };
    press?: { target: number; p95Ms?: number; maxMs?: number; met: boolean };
  };
  /** Frames the capture may have missed: poll failures, overwritten frames, an overrun window. */
  coverageGapReasons: string[];
  /** Why the source has no frames, e.g. an idle screen. Not a gap. */
  unavailableReasons: string[];
  /** Observations that don't change the verdict, e.g. a refresh rate unlike the baseline's. */
  notes: string[];
}

export interface PressStats {
  count: number;
  timed: number;
  /** Timed presses with no standout mount frame, answered by the first frame. */
  firstFrame: number;
  p50Ms?: number;
  p95Ms?: number;
  maxMs?: number;
}

interface CaptureWindow {
  id: string;
  maxDurationMs: number;
  startedAtEpochMs: number;
  result?: Promise<AndroidGfxinfoCaptureResult>;
}

export interface PerformanceCaptureSession {
  handler: ActionHandler;
  /** The runner's node boundaries, used to find the presses inside a window. */
  recordNodeEvent(event: {
    nodeId: string;
    action: string;
    target?: string;
    status: 'running' | 'passed' | 'failed';
  }): void;
  close(): Promise<void>;
}

export interface PerformanceCaptureSessionOptions {
  env: Record<string, string | undefined>;
  logger?: Pick<Console, 'warn'>;
  /** Validate the nodes without a device: no window opens and nothing is measured. */
  dryRun?: boolean;
  createBackend?: (env: Record<string, string | undefined>) => AndroidGfxinfoPerformanceBackend;
  now?: () => number;
}

export function createPerformanceCaptureSession({
  env,
  logger = console,
  dryRun = false,
  createBackend = createDeviceBackend,
  now = Date.now,
}: PerformanceCaptureSessionOptions): PerformanceCaptureSession {
  const spans: RecipeNodeSpan[] = [];
  const windows = new Map<string, CaptureWindow>();
  const summaries: PerformanceWindowSummary[] = [];
  let backend: AndroidGfxinfoPerformanceBackend | undefined;

  const resolveBackend = () => (backend ??= createBackend(env));

  function finish(window: CaptureWindow): Promise<AndroidGfxinfoCaptureResult> {
    window.result ??= resolveBackend().end(window.id);
    return window.result;
  }

  async function execute(
    node: Record<string, unknown>,
    context: ActionExecutionContext,
  ): Promise<ActionResult> {
    const phase = String(node.phase ?? '').toLowerCase();
    if (dryRun) {
      return {
        output: { action: PERFORMANCE_CAPTURE_ACTION, phase, dryRun: true, nodeId: context.nodeId },
      };
    }
    if (phase === 'report') return report(node, context);
    const id = String(node.id ?? '').trim();
    if (!['start', 'end'].includes(phase) || !id) {
      throw new RecipeExecutionError(
        'harness',
        `${PERFORMANCE_CAPTURE_ACTION} requires phase=start|end with a non-empty id, or phase=report.`,
      );
    }
    if (phase === 'start') {
      if (windows.size > 0) {
        throw new RecipeExecutionError(
          'harness',
          `${PERFORMANCE_CAPTURE_ACTION} window ${[...windows.keys()][0]} is still open; end it before starting ${id}.`,
        );
      }
      await resolveBackend().start(id);
      windows.set(id, {
        id,
        maxDurationMs: boundedDuration(node.max_duration_ms),
        startedAtEpochMs: now(),
      });
      return { output: { action: PERFORMANCE_CAPTURE_ACTION, id, phase, status: 'started' } };
    }

    const window = windows.get(id);
    if (!window) {
      throw new RecipeExecutionError('harness', `Performance capture is not active: ${id}`);
    }
    windows.delete(id);
    const result = await finish(window);
    const summary = summarizeWindow({
      id,
      startedAtEpochMs: window.startedAtEpochMs,
      endedAtEpochMs: now(),
      maxDurationMs: window.maxDurationMs,
      result,
      spans,
      budget: parseBudget(node.budget),
      baseline: parseBaseline(node.baseline),
      targets: parseTargets(node.targets),
      sustainedWindowMs: positiveNumber(node.sustained_window_ms) ?? DEFAULT_SUSTAINED_WINDOW_MS,
      responseWindowMs: positiveNumber(node.response_window_ms) ?? DEFAULT_RESPONSE_WINDOW_MS,
    });
    summaries.push(summary);
    const artifactPath = `performance/${safeId(id)}-summary.json`;
    // The frames the summary was read from, so a reviewer can check which frame answered a press.
    const framesPath = `performance/${safeId(id)}-frames.json`;
    await writeArtifact(context, artifactPath, `${JSON.stringify(summary, null, 2)}\n`);
    await writeArtifact(
      context,
      framesPath,
      `${JSON.stringify({ schemaVersion: 1, id, spans: windowSpans(spans, summary), frames: result.nativeUi.samples })}\n`,
    );
    return {
      output: { action: PERFORMANCE_CAPTURE_ACTION, phase, artifactPath, framesPath, ...summary },
      artifacts: [
        { path: artifactPath, type: 'metric', nodeId: context.nodeId, label: `Performance ${id}` },
        { path: framesPath, type: 'json', nodeId: context.nodeId, label: `Frames ${id}` },
      ],
    };
  }

  async function report(
    node: Record<string, unknown>,
    context: ActionExecutionContext,
  ): Promise<ActionResult> {
    const title =
      typeof node.title === 'string' && node.title.trim() ? node.title.trim() : 'Performance';
    if (summaries.length === 0) {
      throw new RecipeExecutionError(
        'harness',
        `${PERFORMANCE_CAPTURE_ACTION} phase=report found no ended capture window.`,
      );
    }
    const failed = summaries.filter((summary) => summary.budget?.verdict === 'fail');
    const inconclusive = summaries.filter((summary) => summary.budget?.verdict === 'inconclusive');
    const environment = {
      device: await describeDevice(),
      checkout: await describeCheckout(context.projectRoot),
    };
    const document = {
      schemaVersion: 1,
      verdict: failed.length > 0 ? 'fail' : inconclusive.length > 0 ? 'inconclusive' : 'pass',
      environment,
      windows: summaries,
    };
    const jsonPath = 'performance/report.json';
    const markdownPath = 'performance/report.md';
    await writeArtifact(context, jsonPath, `${JSON.stringify(document, null, 2)}\n`);
    await writeArtifact(
      context,
      markdownPath,
      renderPerformanceReport(title, summaries, environment),
    );
    const artifacts = [
      { path: jsonPath, type: 'metric', nodeId: context.nodeId, label: `${title} report` },
      { path: markdownPath, type: 'report', nodeId: context.nodeId, label: `${title} report` },
    ];
    if (failed.length > 0 || inconclusive.length > 0) {
      for (const artifact of artifacts) context.registerArtifact(artifact);
      const reasons = [
        ...failed.map((summary) => `${summary.id} (${summary.budget?.failures.join('; ')})`),
        ...inconclusive.map(
          (summary) => `${summary.id} inconclusive (${summary.budget?.inconclusive.join('; ')})`,
        ),
      ];
      throw new RecipeExecutionError(
        failed.length > 0 ? 'subject' : 'environment',
        `Performance budget ${failed.length > 0 ? 'failed' : 'inconclusive'}: ${reasons.join(', ')}`,
        {
          code: failed.length > 0 ? 'PERFORMANCE_BUDGET_FAILED' : 'PERFORMANCE_INCONCLUSIVE',
          details: document,
        },
      );
    }
    return {
      output: { action: PERFORMANCE_CAPTURE_ACTION, phase: 'report', ...document },
      artifacts,
    };
  }

  async function describeDevice(): Promise<AndroidDeviceDescription | undefined> {
    try {
      return await backend?.describe?.();
    } catch (error) {
      // The report still renders without the device line; the reason is logged.
      logger.warn(`Performance report could not describe the device: ${errorMessage(error)}`);
      return undefined;
    }
  }

  return {
    handler: {
      action: PERFORMANCE_CAPTURE_ACTION,
      // Package code, not a recipe's: trusted like the runner's built-in actions.
      source: { kind: 'bundled', trust: 'trusted', name: '@farmslot/adapter-rn' },
      execute,
    },
    recordNodeEvent(event) {
      if (event.status === 'running') {
        spans.push({
          nodeId: event.nodeId,
          action: event.action,
          ...(event.target ? { target: event.target } : {}),
          startedAtEpochMs: now(),
        });
        return;
      }
      for (let index = spans.length - 1; index >= 0; index -= 1) {
        const span = spans[index];
        if (span?.nodeId !== event.nodeId || span.endedAtEpochMs !== undefined) continue;
        span.endedAtEpochMs = now();
        return;
      }
    },
    async close() {
      const open = [...windows.values()];
      windows.clear();
      for (const window of open) {
        // A window still open here belongs to a run that failed before its
        // phase=end. Ending it stops the polling; its error must not replace
        // the run's own, so it is logged.
        await finish(window).catch((error: unknown) => {
          logger.warn(`Performance window ${window.id} did not end: ${errorMessage(error)}`);
        });
      }
      await backend?.close();
    },
  };
}

function createDeviceBackend(
  env: Record<string, string | undefined>,
): AndroidGfxinfoPerformanceBackend {
  const platform = env.PLATFORM ?? '';
  if (!platform.startsWith('android')) {
    throw new RecipeExecutionError(
      'environment',
      `${PERFORMANCE_CAPTURE_ACTION} reads Android gfxinfo frames; it needs PLATFORM=android (got ${platform || 'none'}).`,
    );
  }
  const serial = env.ADB_SERIAL ?? env.ANDROID_SERIAL ?? env.ANDROID_DEVICE ?? '';
  const packageId = env.FARMSLOT_RECIPE_APP_ID ?? '';
  if (!serial || !packageId) {
    throw new RecipeExecutionError(
      'environment',
      `${PERFORMANCE_CAPTURE_ACTION} needs ADB_SERIAL and FARMSLOT_RECIPE_APP_ID for the target app.`,
    );
  }
  return createAndroidGfxinfoPerformanceBackend({
    serial,
    packageId,
    adbPath: resolveMobileToolPath('adb', { required: true }) ?? 'adb',
  });
}

export function summarizeWindow({
  id,
  startedAtEpochMs,
  endedAtEpochMs,
  maxDurationMs,
  result,
  spans,
  budget,
  baseline,
  targets,
  sustainedWindowMs,
  responseWindowMs,
}: {
  id: string;
  startedAtEpochMs: number;
  endedAtEpochMs: number;
  maxDurationMs: number;
  result: AndroidGfxinfoCaptureResult;
  spans: readonly RecipeNodeSpan[];
  budget?: PerformanceBudget;
  baseline?: PerformanceBaseline;
  targets?: PerformanceTargets;
  sustainedWindowMs: number;
  responseWindowMs: number;
}): PerformanceWindowSummary {
  const samples = result.nativeUi.samples;
  const coverageGapReasons = [...result.nativeUi.coverageGapReasons];
  const exceeded = endedAtEpochMs - startedAtEpochMs >= maxDurationMs;
  if (exceeded) coverageGapReasons.push('Performance capture exceeded max_duration_ms.');
  const presses = spans
    .filter(
      (span) =>
        PRESS_ACTIONS.has(span.action) &&
        span.startedAtEpochMs >= startedAtEpochMs &&
        (span.endedAtEpochMs ?? endedAtEpochMs) <= endedAtEpochMs,
    )
    .map((span) =>
      result.inputEvents === 'missing'
        ? {
            nodeId: span.nodeId,
            action: span.action,
            ...(span.target ? { target: span.target } : {}),
            unmeasuredReason:
              "this device's gfxinfo framestats has no InputEventId column (Android 12 or later is needed to time presses)",
          }
        : measurePress(samples, span, responseWindowMs, endedAtEpochMs),
    );
  const press = pressStats(presses);
  const pressByTarget: Record<string, PressStats> = {};
  for (const target of new Set(presses.map((entry) => entry.target ?? entry.nodeId))) {
    pressByTarget[target] = pressStats(
      presses.filter((entry) => (entry.target ?? entry.nodeId) === target),
    );
  }
  const frames = summarizeFrames(samples);
  const sustainedFps = lowestSustainedFps(samples, sustainedWindowMs);
  const summary: PerformanceWindowSummary = {
    schemaVersion: 1,
    id,
    status: exceeded ? 'partial' : result.nativeUi.status,
    platform: 'android',
    source: result.nativeUi.kind,
    startedAtEpochMs,
    endedAtEpochMs,
    durationMs: endedAtEpochMs - startedAtEpochMs,
    frames,
    ...(sustainedFps === undefined ? {} : { sustainedFps }),
    sustainedWindowMs,
    presses,
    press,
    pressByTarget,
    coverageGapReasons,
    unavailableReasons: [...result.nativeUi.unavailableReasons],
    notes: [],
  };
  if (
    baseline?.refresh_hz !== undefined &&
    frames.refreshRateHz !== undefined &&
    Math.abs(frames.refreshRateHz - baseline.refresh_hz) > baseline.refresh_hz * 0.05
  ) {
    summary.notes.push(
      `measured ${Math.round(frames.refreshRateHz)} Hz; the baseline was recorded at ${baseline.refresh_hz} Hz`,
    );
  }
  if (baseline) summary.baseline = baseline;
  if (budget) summary.budget = checkBudget(summary, budget, baseline);
  if (targets) summary.targets = checkTargets(summary, targets);
  return summary;
}

/**
 * The press's latency: from the first frame that handled input during the
 * press node to the end of the frame that answered it. The answer is the
 * first later frame that stands out (see MOUNT_MIN_MS): the frame that mounts
 * and draws the new screen. Touch ripples run on the render thread. A mount up
 * to `MOUNT_LOOKAHEAD` response windows after the touch still answers when
 * nothing rendered in the window or rendering ran on into it without a pause,
 * so a late mount reads as slow rather than as an instant press. When no frame
 * stands out the press is timed to the first frame within `responseWindowMs`.
 * A press with no input frame, or no frame after it in the window, is untimed.
 */
export function measurePress(
  samples: readonly AndroidFrameSample[],
  span: RecipeNodeSpan,
  responseWindowMs: number,
  windowEndEpochMs: number,
): PressLatency {
  const base = {
    nodeId: span.nodeId,
    action: span.action,
    ...(span.target ? { target: span.target } : {}),
  };
  const spanEnd = span.endedAtEpochMs ?? windowEndEpochMs;
  const input = samples.find(
    (sample) =>
      sample.input === true &&
      sample.startedAtEpochMs >= span.startedAtEpochMs &&
      sample.startedAtEpochMs <= spanEnd,
  );
  if (!input) return { ...base, unmeasuredReason: 'no frame handled input during the press' };
  const searchEnd = Math.min(
    windowEndEpochMs,
    input.startedAtEpochMs + responseWindowMs * MOUNT_LOOKAHEAD,
  );
  const windowEnd = input.startedAtEpochMs + responseWindowMs;
  const candidates = samples
    .filter(
      (sample) =>
        sample.input !== true &&
        sample.startedAtEpochMs > input.startedAtEpochMs &&
        sample.startedAtEpochMs <= searchEnd,
    )
    .sort((left, right) => left.startedAtEpochMs - right.startedAtEpochMs);
  // Past the window, only frames that continue the rendering under way at its
  // end (or any, when the window had none): a later mount after a pause is
  // another update, not this press.
  const after: AndroidFrameSample[] = [];
  for (const sample of candidates) {
    const previous = after.at(-1);
    if (
      sample.startedAtEpochMs > windowEnd &&
      previous &&
      sample.startedAtEpochMs - previous.startedAtEpochMs > MAX_ACTIVE_GAP_MS
    ) {
      break;
    }
    after.push(sample);
  }
  const work = (sample: AndroidFrameSample) => sample.uiThreadMs ?? sample.durationMs;
  const standsOut = (sample: AndroidFrameSample) => {
    const ms = work(sample);
    if (ms < MOUNT_MIN_MS) return false;
    if (ms >= (sample.frameBudgetMs ?? 1000 / 60)) return true;
    const others = after
      .filter((other) => other !== sample)
      .map(work)
      .sort((left, right) => left - right);
    return others.length === 0 || ms >= percentile(others, 0.5) * MOUNT_OVER_MEDIAN;
  };
  const mount = after.find(standsOut);
  const response = mount ?? after.find((sample) => sample.startedAtEpochMs <= windowEnd);
  if (!response) {
    return {
      ...base,
      unmeasuredReason: `no frame answered the input within ${responseWindowMs} ms`,
    };
  }
  return {
    ...base,
    latencyMs: round(response.completedAtEpochMs - input.startedAtEpochMs),
    answer: mount ? 'mount' : 'first-frame',
  };
}

/**
 * The lowest frame rate over any `windowMs` of continuous rendering: frames
 * closer than MAX_ACTIVE_GAP_MS (or a gap a slow frame explains) form one
 * stretch, and only stretches that last a whole `windowMs` from a frame count.
 * Undefined when no stretch is that long (an idle screen, a short burst).
 */
export function lowestSustainedFps(
  samples: readonly AndroidFrameSample[],
  windowMs: number,
): number | undefined {
  const ordered = [...samples].sort(
    (first, second) => first.startedAtEpochMs - second.startedAtEpochMs,
  );
  const stretches: AndroidFrameSample[][] = [];
  for (const sample of ordered) {
    const stretch = stretches.at(-1);
    const previous = stretch?.at(-1);
    const gap = previous ? sample.startedAtEpochMs - previous.startedAtEpochMs : Infinity;
    const budget = sample.frameBudgetMs ?? 1000 / 60;
    const explained = previous ? previous.durationMs + budget * 1.01 >= gap : false;
    if (stretch && (gap <= MAX_ACTIVE_GAP_MS || explained)) stretch.push(sample);
    else stretches.push([sample]);
  }
  let lowest: number | undefined;
  for (const stretch of stretches) {
    const last = stretch.at(-1)?.startedAtEpochMs ?? 0;
    for (let start = 0; start < stretch.length; start += 1) {
      const from = stretch[start]?.startedAtEpochMs ?? 0;
      if (from + windowMs > last) break;
      let end = start;
      while ((stretch[end + 1]?.startedAtEpochMs ?? Infinity) <= from + windowMs) end += 1;
      const intervals = end - start;
      const elapsed = (stretch[end]?.startedAtEpochMs ?? from) - from;
      if (intervals < MIN_SUSTAINED_INTERVALS || elapsed <= 0) continue;
      // Sampling jitter never reads faster than the display refreshes.
      const budgets = stretch
        .slice(start, end + 1)
        .map((sample) => sample.frameBudgetMs ?? 1000 / 60);
      const refreshHz = 1000 / Math.min(...budgets);
      const fps = round(Math.min(refreshHz, (intervals * 1000) / elapsed));
      lowest = Math.min(lowest ?? fps, fps);
    }
  }
  return lowest;
}

// Every failure names the metric, the limit, the measured value, where it was
// measured and, given a baseline, the baseline's value. Values print with
// enough decimals that a value over its limit never reads as equal to it.
function checkBudget(
  summary: PerformanceWindowSummary,
  limits: PerformanceBudget,
  baseline: PerformanceBaseline | undefined,
): NonNullable<PerformanceWindowSummary['budget']> {
  const failures: string[] = [];
  const against = (name: string, value: number | undefined, unit: string) =>
    baseline && value !== undefined
      ? `; ${baseline.label} baseline ${name} ${formatValue(value)} ${unit}`
      : '';
  if (
    limits.min_sustained_fps !== undefined &&
    summary.sustainedFps !== undefined &&
    summary.sustainedFps < limits.min_sustained_fps
  ) {
    failures.push(
      `sustained fps (${FPS_METRIC}) ${formatAgainst(summary.sustainedFps, limits.min_sustained_fps)} fps < ${
        limits.min_sustained_fps
      } fps (${summary.id})${against('sustained', baseline?.sustained_fps, 'fps')}`,
    );
  }
  if (
    limits.max_press_p95_ms !== undefined &&
    summary.press.p95Ms !== undefined &&
    summary.press.p95Ms > limits.max_press_p95_ms
  ) {
    const [slowest, stats] = Object.entries(summary.pressByTarget).reduce<
      [string, PressStats] | [undefined, undefined]
    >(
      (worst, entry) => ((entry[1].maxMs ?? 0) > (worst[1]?.maxMs ?? -1) ? entry : worst),
      [undefined, undefined],
    );
    failures.push(
      `press p95 (${PRESS_METRIC}) ${formatAgainst(summary.press.p95Ms, limits.max_press_p95_ms)} ms > ${
        limits.max_press_p95_ms
      } ms (${summary.id}${
        slowest && stats?.maxMs !== undefined
          ? `; slowest ${slowest} ${formatValue(stats.maxMs)} ms`
          : ''
      })${against('p95', baseline?.press_p95_ms, 'ms')}`,
    );
  }
  if (limits.max_press_ms !== undefined) {
    for (const press of summary.presses) {
      const where = `${press.target ?? press.nodeId}, node ${press.nodeId}`;
      if (press.latencyMs === undefined) {
        failures.push(
          `press (${PRESS_METRIC}) untimed, counted over ${limits.max_press_ms} ms (${where}): ${
            press.unmeasuredReason
          }${against('max', baseline?.press_max_ms, 'ms')}`,
        );
      } else if (press.latencyMs > limits.max_press_ms) {
        failures.push(
          `press (${PRESS_METRIC}) ${formatAgainst(press.latencyMs, limits.max_press_ms)} ms > ${
            limits.max_press_ms
          } ms (${where})${against('max', baseline?.press_max_ms, 'ms')}`,
        );
      }
    }
  }
  if (limits.min_frames !== undefined && summary.frames.frameCount < limits.min_frames) {
    failures.push(
      `gfxinfo frames ${summary.frames.frameCount} < ${limits.min_frames} (${summary.id})${against(
        'frames',
        baseline?.frames,
        '',
      ).trimEnd()}`,
    );
  }
  const inconclusive = summary.coverageGapReasons.map((reason) => `coverage gap: ${reason}`);
  return {
    verdict: failures.length > 0 ? 'fail' : inconclusive.length > 0 ? 'inconclusive' : 'pass',
    limits,
    failures,
    inconclusive,
  };
}

/** The value with the fewest decimals (up to 3) that don't round it onto `limit`. */
function formatAgainst(value: number, limit: number): string {
  for (let decimals = 0; decimals < 3; decimals += 1) {
    const text = value.toFixed(decimals);
    if (Number(text) !== limit) return String(Number(text));
  }
  return String(Number(value.toFixed(3)));
}

function formatValue(value: number): string {
  return String(Math.round(value * 10) / 10);
}

async function describeCheckout(
  projectRoot: string,
): Promise<{ head?: string; dirty?: boolean } | undefined> {
  try {
    const head = (
      await execFileAsync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    ).stdout.trim();
    const status = (
      await execFileAsync(
        'git',
        ['-C', projectRoot, 'status', '--porcelain', '--untracked-files=no'],
        { encoding: 'utf8' },
      )
    ).stdout.trim();
    return { head, dirty: status.length > 0 };
  } catch {
    // Outside a git checkout the report names no source revision.
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function windowSpans(
  spans: readonly RecipeNodeSpan[],
  summary: Pick<PerformanceWindowSummary, 'startedAtEpochMs' | 'endedAtEpochMs'>,
): RecipeNodeSpan[] {
  return spans.filter(
    (span) =>
      span.startedAtEpochMs >= summary.startedAtEpochMs &&
      span.startedAtEpochMs <= summary.endedAtEpochMs,
  );
}

function pressStats(presses: readonly PressLatency[]): PressStats {
  const timed = presses
    .map((press) => press.latencyMs)
    .filter((value): value is number => value !== undefined)
    .sort((first, second) => first - second);
  return {
    count: presses.length,
    timed: timed.length,
    firstFrame: presses.filter((press) => press.answer === 'first-frame').length,
    ...(timed.length > 0
      ? {
          p50Ms: round(percentile(timed, 0.5)),
          p95Ms: round(percentile(timed, 0.95)),
          maxMs: round(timed.at(-1) ?? 0),
        }
      : {}),
  };
}

function checkTargets(
  summary: PerformanceWindowSummary,
  targets: PerformanceTargets,
): NonNullable<PerformanceWindowSummary['targets']> {
  return {
    ...(targets.fps === undefined
      ? {}
      : {
          fps: {
            target: targets.fps,
            ...(summary.sustainedFps === undefined ? {} : { sustainedFps: summary.sustainedFps }),
            ...(summary.frames.activeFps === undefined
              ? {}
              : { activeFps: summary.frames.activeFps }),
            met: summary.sustainedFps === undefined || summary.sustainedFps >= targets.fps,
          },
        }),
    ...(targets.press_ms === undefined
      ? {}
      : {
          press: {
            target: targets.press_ms,
            ...(summary.press.p95Ms === undefined ? {} : { p95Ms: summary.press.p95Ms }),
            ...(summary.press.maxMs === undefined ? {} : { maxMs: summary.press.maxMs }),
            met: summary.press.maxMs === undefined || summary.press.maxMs <= targets.press_ms,
          },
        }),
  };
}

export interface PerformanceReportEnvironment {
  device?: AndroidDeviceDescription;
  checkout?: { head?: string; dirty?: boolean };
}

export function renderPerformanceReport(
  title: string,
  summaries: readonly PerformanceWindowSummary[],
  environment: PerformanceReportEnvironment = {},
): string {
  const value = (number: number | undefined, unit = '') =>
    number === undefined ? 'n/a' : `${Math.round(number * 10) / 10}${unit}`;
  const rows = summaries.map((summary) => {
    const fpsTarget = summary.targets?.fps;
    const toTarget =
      fpsTarget && summary.sustainedFps !== undefined
        ? `${Math.round((Math.min(summary.sustainedFps, fpsTarget.target) / fpsTarget.target) * 100)}% of ${fpsTarget.target}`
        : 'n/a';
    return [
      summary.id,
      summary.budget?.verdict ?? 'n/a',
      value(summary.sustainedFps),
      value(summary.frames.activeFps),
      toTarget,
      `${value(summary.press.p50Ms)} / ${value(summary.press.p95Ms)} / ${value(summary.press.maxMs)}`,
      value(summary.frames.longestFrameMs, ' ms'),
      value(summary.frames.overBudgetFramePercent, '%'),
      String(summary.frames.frameCount),
      value(summary.frames.refreshRateHz),
    ];
  });
  const header = [
    'flow',
    'budget',
    'sustained fps',
    'active fps',
    'fps target',
    'press p50 / p95 / max (ms)',
    'worst frame',
    'janky',
    'frames',
    'Hz',
  ];
  const { device, checkout } = environment;
  const lines = [
    `# ${title}`,
    '',
    `- Device: ${
      device
        ? [
            device.model ?? 'unknown model',
            device.androidRelease ? `Android ${device.androidRelease}` : '',
            device.serial,
          ]
            .filter(Boolean)
            .join(', ')
        : 'unknown'
    }`,
    `- App: ${
      device
        ? [
            device.packageId,
            device.versionName,
            device.buildType ? `${device.buildType} build` : '',
            device.lastUpdateTime ? `installed ${device.lastUpdateTime}` : '',
          ]
            .filter(Boolean)
            .join(', ')
        : 'unknown'
    }`,
    `- Checkout: ${checkout?.head ? `${checkout.head}${checkout.dirty ? ' (uncommitted changes)' : ''}` : 'unknown'}`,
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
  ];
  const targets = summaries.flatMap((summary) =>
    Object.entries(summary.pressByTarget).map(([target, stats]) => [
      summary.id,
      target,
      `${stats.timed}/${stats.count}${stats.firstFrame > 0 ? ` (${stats.firstFrame} first-frame)` : ''}`,
      `${value(stats.p50Ms)} / ${value(stats.p95Ms)} / ${value(stats.maxMs)}`,
      summary.targets?.press
        ? stats.maxMs !== undefined && stats.maxMs <= summary.targets.press.target
          ? 'yes'
          : 'no'
        : 'n/a',
    ]),
  );
  if (targets.length > 0) {
    lines.push(
      '| flow | press target | timed | p50 / p95 / max (ms) | within press target |',
      '| --- | --- | --- | --- | --- |',
      ...targets.map((row) => `| ${row.join(' | ')} |`),
      '',
    );
  }
  for (const summary of summaries) {
    const baseline = summary.baseline;
    if (!baseline) continue;
    const parts = [
      baseline.press_p95_ms === undefined ? '' : `press p95 ${value(baseline.press_p95_ms, ' ms')}`,
      baseline.press_max_ms === undefined ? '' : `max ${value(baseline.press_max_ms, ' ms')}`,
      baseline.sustained_fps === undefined ? '' : `sustained ${value(baseline.sustained_fps)} fps`,
      baseline.frames === undefined ? '' : `${baseline.frames} frames`,
      baseline.refresh_hz === undefined ? '' : `${baseline.refresh_hz} Hz`,
    ].filter(Boolean);
    lines.push(`- ${summary.id} baseline, ${baseline.label}: ${parts.join(', ') || 'recorded'}`);
  }
  for (const summary of summaries) {
    for (const failure of summary.budget?.failures ?? []) lines.push(`- FAIL ${failure}`);
    for (const reason of summary.budget?.inconclusive ?? []) {
      lines.push(`- INCONCLUSIVE ${summary.id}: ${reason}`);
    }
    for (const note of summary.notes) lines.push(`- NOTE ${summary.id}: ${note}`);
  }
  // Budgeted windows list their gaps as INCONCLUSIVE above.
  const gaps = summaries.filter(
    (summary) => !summary.budget && summary.coverageGapReasons.length > 0,
  );
  for (const summary of gaps) {
    lines.push(`- ${summary.id} coverage: ${summary.coverageGapReasons.join('; ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseBudget(value: unknown): PerformanceBudget | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, 'budget');
  return {
    ...optionalLimit(record, 'min_sustained_fps'),
    ...optionalLimit(record, 'max_press_p95_ms'),
    ...optionalLimit(record, 'max_press_ms'),
    ...optionalLimit(record, 'min_frames'),
  };
}

function parseBaseline(value: unknown): PerformanceBaseline | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, 'baseline');
  if (typeof record.label !== 'string' || !record.label.trim()) {
    throw new RecipeExecutionError(
      'harness',
      `${PERFORMANCE_CAPTURE_ACTION} baseline.label must be a non-empty string.`,
    );
  }
  return {
    ...record,
    label: record.label.trim(),
    ...optionalLimit(record, 'sustained_fps'),
    ...optionalLimit(record, 'press_p95_ms'),
    ...optionalLimit(record, 'press_max_ms'),
    ...optionalLimit(record, 'frames'),
    ...optionalLimit(record, 'refresh_hz'),
  };
}

function parseTargets(value: unknown): PerformanceTargets | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, 'targets');
  return { ...optionalLimit(record, 'fps'), ...optionalLimit(record, 'press_ms') };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }
  throw new RecipeExecutionError(
    'harness',
    `${PERFORMANCE_CAPTURE_ACTION} ${label} must be an object.`,
  );
}

function optionalLimit<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, number>> {
  const raw = record[key];
  if (raw === undefined) return {};
  const number = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) {
    throw new RecipeExecutionError(
      'harness',
      `${PERFORMANCE_CAPTURE_ACTION} ${key} must be a positive number.`,
    );
  }
  const limit: Partial<Record<K, number>> = {};
  limit[key] = number;
  return limit;
}

async function writeArtifact(
  context: ActionExecutionContext,
  relativePath: string,
  content: string,
): Promise<void> {
  const file = context.resolveArtifactPath(relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

function boundedDuration(value: unknown): number {
  const number = positiveNumber(value);
  return number === undefined ? DEFAULT_MAX_DURATION_MS : Math.min(number, MAX_DURATION_MS);
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/gu, '-');
}
