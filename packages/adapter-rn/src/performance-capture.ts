// app.performance_capture on adapter-rn runs. `phase: "start"` opens a named
// window on the device's native frames, `phase: "end"` closes it and writes
// its summary (frames, the lowest sustained FPS, the latency of every press
// inside it, and the window's budget verdict), and `phase: "report"` writes
// one report over every window of the run and fails the node when a window
// broke its budget. Targets are reported, never failed on.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type ActionExecutionContext,
  type ActionHandler,
  type ActionResult,
  RecipeExecutionError,
} from '@farmslot/recipe-runner';
import {
  type FrameMetricSummary,
  type PerformanceSourceStatus,
  summarizeFrames,
} from '@farmslot/recipe-runner/runtime/cdp-trace';

import {
  type AndroidFrameSample,
  type AndroidGfxinfoCaptureResult,
  type AndroidGfxinfoPerformanceBackend,
  createAndroidGfxinfoPerformanceBackend,
} from './android-gfxinfo-performance.js';
import { resolveMobileToolPath } from './tool-paths.js';

export const PERFORMANCE_CAPTURE_ACTION = 'app.performance_capture';

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
// (about 1 ms of UI-thread work on a Pixel 6); tab mounts measured 9-80 ms.
const MOUNT_MIN_MS = 4;
const MOUNT_OVER_MEDIAN = 3;
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
   * `mount`: the heaviest frame after the touch stood out and is the answer.
   * `first-frame`: none stood out (the screen was already mounted), so the
   * press is timed to the first frame after the touch.
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
  budget?: { verdict: 'pass' | 'fail'; limits: PerformanceBudget; failures: string[] };
  baseline?: PerformanceBaseline;
  targets?: {
    fps?: { target: number; sustainedFps?: number; activeFps?: number; met: boolean };
    press?: { target: number; p95Ms?: number; maxMs?: number; met: boolean };
  };
  coverageGapReasons: string[];
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
  /** Validate the nodes without a device: no window opens and nothing is measured. */
  dryRun?: boolean;
  createBackend?: (env: Record<string, string | undefined>) => AndroidGfxinfoPerformanceBackend;
  now?: () => number;
}

export function createPerformanceCaptureSession({
  env,
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
    const failed = summaries.filter((summary) => summary.budget?.verdict === 'fail');
    const document = {
      schemaVersion: 1,
      verdict: failed.length > 0 ? 'fail' : 'pass',
      windows: summaries,
    };
    const jsonPath = 'performance/report.json';
    const markdownPath = 'performance/report.md';
    await writeArtifact(context, jsonPath, `${JSON.stringify(document, null, 2)}\n`);
    await writeArtifact(context, markdownPath, renderPerformanceReport(title, summaries));
    const artifacts = [
      { path: jsonPath, type: 'metric', nodeId: context.nodeId, label: `${title} report` },
      { path: markdownPath, type: 'report', nodeId: context.nodeId, label: `${title} report` },
    ];
    if (summaries.length === 0) {
      throw new RecipeExecutionError(
        'harness',
        `${PERFORMANCE_CAPTURE_ACTION} phase=report found no ended capture window.`,
      );
    }
    if (failed.length > 0) {
      for (const artifact of artifacts) context.registerArtifact(artifact);
      throw new RecipeExecutionError(
        'subject',
        `Performance budget failed: ${failed
          .map((summary) => `${summary.id} (${summary.budget?.failures.join('; ')})`)
          .join(', ')}`,
        { code: 'PERFORMANCE_BUDGET_FAILED', details: document },
      );
    }
    return {
      output: { action: PERFORMANCE_CAPTURE_ACTION, phase: 'report', ...document },
      artifacts,
    };
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
      for (const window of open) await finish(window).catch(() => undefined);
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
  const coverageGapReasons = [
    ...result.nativeUi.unavailableReasons,
    ...result.nativeUi.coverageGapReasons,
  ];
  const exceeded = endedAtEpochMs - startedAtEpochMs >= maxDurationMs;
  if (exceeded) coverageGapReasons.push('Performance capture exceeded max_duration_ms.');
  const presses = spans
    .filter(
      (span) =>
        PRESS_ACTIONS.has(span.action) &&
        span.startedAtEpochMs >= startedAtEpochMs &&
        (span.endedAtEpochMs ?? endedAtEpochMs) <= endedAtEpochMs,
    )
    .map((span) => measurePress(samples, span, responseWindowMs, endedAtEpochMs));
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
  };
  if (baseline) summary.baseline = baseline;
  if (budget) summary.budget = checkBudget(summary, budget, baseline);
  if (targets) summary.targets = checkTargets(summary, targets);
  return summary;
}

/**
 * The press's latency: from the first frame that handled input during the
 * press node to the end of the frame that answered it. The answer is the
 * frame with the most UI-thread work within `responseWindowMs` of the input
 * when it stands out (at least `MOUNT_MIN_MS` and `MOUNT_OVER_MEDIAN` times
 * the window's median): the frame that mounts and draws the new screen.
 * Touch ripples run on the render thread. When no frame stands out the screen
 * was already mounted, and the first frame after the touch answers. The answer
 * may land after the press node ends. A press with no input frame, or no frame
 * after it in the window, is untimed.
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
  const responseEnd = Math.min(windowEndEpochMs, input.startedAtEpochMs + responseWindowMs);
  const after = samples
    .filter(
      (sample) =>
        sample.input !== true &&
        sample.startedAtEpochMs > input.startedAtEpochMs &&
        sample.startedAtEpochMs <= responseEnd,
    )
    .sort((left, right) => left.startedAtEpochMs - right.startedAtEpochMs);
  const [first] = after;
  if (!first) {
    return {
      ...base,
      unmeasuredReason: `no frame answered the input within ${responseWindowMs} ms`,
    };
  }
  const work = (sample: AndroidFrameSample) => sample.uiThreadMs ?? sample.durationMs;
  const heaviest = after.reduce((top, sample) => (work(sample) > work(top) ? sample : top));
  const works = after.map(work).sort((left, right) => left - right);
  const mount =
    work(heaviest) >= MOUNT_MIN_MS && work(heaviest) >= percentile(works, 0.5) * MOUNT_OVER_MEDIAN;
  const response = mount ? heaviest : first;
  return {
    ...base,
    latencyMs: round(response.completedAtEpochMs - input.startedAtEpochMs),
    answer: mount ? 'mount' : 'first-frame',
  };
}

/** The lowest active FPS over any `windowMs` span of frames; undefined when no span has enough. */
export function lowestSustainedFps(
  samples: readonly AndroidFrameSample[],
  windowMs: number,
): number | undefined {
  const ordered = [...samples].sort(
    (first, second) => first.startedAtEpochMs - second.startedAtEpochMs,
  );
  let lowest: number | undefined;
  let end = 0;
  for (let start = 0; start < ordered.length; start += 1) {
    const from = ordered[start]?.startedAtEpochMs ?? 0;
    end = Math.max(end, start);
    while (end < ordered.length && (ordered[end]?.startedAtEpochMs ?? 0) < from + windowMs) {
      end += 1;
    }
    const fps = summarizeFrames(ordered.slice(start, end)).activeFps;
    if (fps !== undefined) lowest = Math.min(lowest ?? fps, fps);
  }
  return lowest;
}

// Every failure names the metric, the limit, the measured value, where it was
// measured and, given a baseline, the baseline's value.
function checkBudget(
  summary: PerformanceWindowSummary,
  limits: PerformanceBudget,
  baseline: PerformanceBaseline | undefined,
): NonNullable<PerformanceWindowSummary['budget']> {
  const failures: string[] = [];
  const fps = (value: number) => `${Math.round(value * 10) / 10} fps`;
  const ms = (value: number) => `${Math.round(value)} ms`;
  const against = (name: string, value: number | undefined, format: (value: number) => string) =>
    baseline && value !== undefined ? `; ${baseline.label} baseline ${name} ${format(value)}` : '';
  if (
    limits.min_sustained_fps !== undefined &&
    summary.sustainedFps !== undefined &&
    summary.sustainedFps < limits.min_sustained_fps
  ) {
    failures.push(
      `sustained fps (${FPS_METRIC}) ${fps(summary.sustainedFps)} < ${fps(
        limits.min_sustained_fps,
      )} (${summary.id})${against('sustained', baseline?.sustained_fps, fps)}`,
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
      `press p95 (${PRESS_METRIC}) ${ms(summary.press.p95Ms)} > ${ms(limits.max_press_p95_ms)} (${
        summary.id
      }${slowest && stats?.maxMs !== undefined ? `; slowest ${slowest} ${ms(stats.maxMs)}` : ''})${against(
        'p95',
        baseline?.press_p95_ms,
        ms,
      )}`,
    );
  }
  if (limits.max_press_ms !== undefined) {
    for (const press of summary.presses) {
      const where = `${press.target ?? press.nodeId}, node ${press.nodeId}`;
      if (press.latencyMs === undefined) {
        failures.push(`press (${PRESS_METRIC}) untimed (${where}): ${press.unmeasuredReason}`);
      } else if (press.latencyMs > limits.max_press_ms) {
        failures.push(
          `press (${PRESS_METRIC}) ${ms(press.latencyMs)} > ${ms(limits.max_press_ms)} (${where})${against(
            'max',
            baseline?.press_max_ms,
            ms,
          )}`,
        );
      }
    }
  }
  if (limits.min_frames !== undefined && summary.frames.frameCount < limits.min_frames) {
    failures.push(
      `gfxinfo frames ${summary.frames.frameCount} < ${limits.min_frames} (${summary.id})`,
    );
  }
  return { verdict: failures.length > 0 ? 'fail' : 'pass', limits, failures };
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

export function renderPerformanceReport(
  title: string,
  summaries: readonly PerformanceWindowSummary[],
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
  const lines = [
    `# ${title}`,
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
    ].filter(Boolean);
    lines.push(`- ${summary.id} baseline, ${baseline.label}: ${parts.join(', ') || 'recorded'}`);
  }
  for (const summary of summaries) {
    for (const failure of summary.budget?.failures ?? []) lines.push(`- FAIL ${failure}`);
  }
  const gaps = summaries.filter((summary) => summary.coverageGapReasons.length > 0);
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
