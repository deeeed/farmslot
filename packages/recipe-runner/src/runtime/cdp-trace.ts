// CDP performance traces: start and end a `Tracing` capture over a CDP
// client, align it to the host clock through a marker written into the trace,
// and turn it into JavaScript-task and native-frame samples with summaries.
// The host names what a trace captures with a `TraceKind`.
import { type FrameMetricSummary, type FrameSample, summarizeFrames } from './frame-metrics.js';
import {
  type JavaScriptTaskMetricSummary,
  type JavaScriptTaskSample,
  summarizeJavaScriptTasks,
} from './js-task-metrics.js';

export {
  type FrameMetricSummary,
  type FrameSample,
  type JavaScriptTaskMetricSummary,
  type JavaScriptTaskSample,
  summarizeFrames,
  summarizeJavaScriptTasks,
};

const MAX_TRACE_BYTES = 16 * 1024 * 1024;
const MAX_TRACE_EVENTS = 250_000;
const DEFAULT_MARKER_PREFIX = 'farmslot-clock-';

// What a trace captures. A renderer-scoped trace (a browser page) keeps only
// the events of the process that emitted the clock marker; an unscoped one (a
// React Native host) keeps them all.
export interface TraceKind {
  categories: readonly string[];
  rendererScoped: boolean;
  // `trace.scope` once the trace is scoped; 'unresolved' otherwise.
  scope: string;
  // `nativeUi.kind` of the frame samples.
  nativeSource: string;
  // Whether JavaScript runtime tasks are attributable in this trace.
  javascriptTasks: boolean;
  // 'draw': one sample per frame, BeginFrame to DrawFrame (frame work).
  // 'cadence': one sample per interval between consecutive BeginFrames.
  frameTiming: 'draw' | 'cadence';
}

export type PerformanceSourceStatus = 'complete' | 'partial' | 'unavailable';

interface PerformanceSourceResult<TSample, TSummary> {
  status: PerformanceSourceStatus;
  kind: string;
  unavailableReasons: string[];
  coverageGapReasons: string[];
  samples: TSample[];
  summary: TSummary;
  clockSyncUncertaintyMs?: number;
}

type JavaScriptPerformanceSourceBase = Omit<
  PerformanceSourceResult<JavaScriptTaskSample, JavaScriptTaskMetricSummary>,
  'summary'
>;

export type JavaScriptPerformanceSourceResult =
  | (JavaScriptPerformanceSourceBase & {
      applicability: 'applicable';
      summary: JavaScriptTaskMetricSummary;
    })
  | (JavaScriptPerformanceSourceBase & {
      applicability: 'not_applicable';
      summary: Record<string, never>;
    });

export type NativeUiPerformanceSourceResult = PerformanceSourceResult<
  FrameSample,
  FrameMetricSummary
>;

export interface PerformanceCaptureResult {
  platform: string;
  javascript: JavaScriptPerformanceSourceResult;
  nativeUi: NativeUiPerformanceSourceResult;
  trace: TraceEvidence;
  rawTraceEvents?: TraceEvent[];
}

export interface TraceEvidence {
  beginFrameCount: number;
  dataLossOccurred: boolean;
  drawFrameCount: number;
  overflow: boolean;
  profileChunkCount: number;
  rendererProcessId?: number;
  runTaskCount: number;
  scope: string;
  totalEventCount: number;
}

export interface PerformanceBackend {
  start(id: string): Promise<void>;
  end(id: string): Promise<PerformanceCaptureResult>;
  close(): Promise<void>;
}

export interface CdpClient {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void;
  close(): void;
}

export interface TraceEvent {
  name?: string;
  cat?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  pid?: number;
  tid?: number;
  args?: Record<string, unknown>;
}

export interface TraceCapture {
  platform: string;
  events: TraceEvent[];
  markerName?: string;
  markerHostEpochMs?: number;
  markerUncertaintyMs?: number;
  dataLossOccurred: boolean;
  overflow: boolean;
  unavailableReasons: string[];
  coverageGapReasons: string[];
}

// When, on the host clock, the clock marker was written, and how far off that can be.
export interface TraceClockSync {
  hostEpochMs: number;
  uncertaintyMs: number;
}

export interface CdpTraceCollectorOptions {
  kind: TraceKind;
  // Reported as `platform` on every result.
  platform: string;
  // Writes a trace event named `name` (e.g. `performance.mark(name)` in the page).
  marker(name: string): Promise<TraceClockSync>;
  // The marker is named `<markerPrefix><capture id>-<Date.now()>`.
  markerPrefix?: string;
}

export function createCdpTraceCollector(
  client: CdpClient,
  { kind, platform, marker, markerPrefix = DEFAULT_MARKER_PREFIX }: CdpTraceCollectorOptions,
): PerformanceBackend {
  let active:
    | {
        id: string;
        events: TraceEvent[];
        bytes: number;
        overflow: boolean;
        markerName?: string;
        markerHostEpochMs?: number;
        markerUncertaintyMs?: number;
        dataLossOccurred: boolean;
        complete?: () => void;
        completePromise: Promise<void>;
      }
    | undefined;

  const offData = client.on('Tracing.dataCollected', (params) => {
    if (!active || !Array.isArray(params.value)) return;
    for (const value of params.value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const event = value as TraceEvent;
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (active.events.length >= MAX_TRACE_EVENTS || active.bytes + bytes > MAX_TRACE_BYTES) {
        active.overflow = true;
        continue;
      }
      active.events.push(event);
      active.bytes += bytes;
    }
  });
  const offComplete = client.on('Tracing.tracingComplete', (params) => {
    if (!active) return;
    active.dataLossOccurred = params.dataLossOccurred === true;
    active.complete?.();
  });

  return {
    async start(id) {
      if (active) throw new Error('Only one CDP performance trace may be active.');
      let complete: (() => void) | undefined;
      const completePromise = new Promise<void>((resolve) => {
        complete = resolve;
      });
      active = {
        id,
        events: [],
        bytes: 0,
        overflow: false,
        dataLossOccurred: false,
        complete,
        completePromise,
      };
      let tracingStarted = false;
      try {
        await client.send(
          'Tracing.start',
          {
            categories: kind.categories.join(','),
            transferMode: 'ReportEvents',
          },
          15_000,
        );
        tracingStarted = true;
        const markerName = `${markerPrefix}${id}-${Date.now()}`;
        const sync = await marker(markerName);
        active.markerName = markerName;
        active.markerHostEpochMs = sync.hostEpochMs;
        active.markerUncertaintyMs = sync.uncertaintyMs;
      } catch (error) {
        if (tracingStarted) {
          await client.send('Tracing.end', {}, 5_000).catch(() => undefined);
          await withTimeout(
            active.completePromise,
            1_000,
            'CDP tracing cleanup did not report tracingComplete.',
          ).catch(() => undefined);
        }
        active = undefined;
        throw error;
      }
    },
    async end(id) {
      const capture = active;
      if (!capture || capture.id !== id) {
        throw new Error(`Performance capture is not active: ${id}`);
      }
      try {
        await client.send('Tracing.end', {}, 15_000);
        await withTimeout(
          capture.completePromise,
          30_000,
          'CDP tracing did not report tracingComplete.',
        );
      } finally {
        active = undefined;
      }
      return parseTraceCapture(
        {
          platform,
          events: capture.events,
          markerName: capture.markerName,
          markerHostEpochMs: capture.markerHostEpochMs,
          markerUncertaintyMs: capture.markerUncertaintyMs,
          dataLossOccurred: capture.dataLossOccurred,
          overflow: capture.overflow,
          unavailableReasons: [],
          coverageGapReasons: [],
        },
        kind,
      );
    },
    async close() {
      if (active) {
        await client.send('Tracing.end', {}, 5_000).catch(() => undefined);
        await withTimeout(
          active.completePromise,
          1_000,
          'CDP tracing cleanup did not report tracingComplete.',
        ).catch(() => undefined);
        active = undefined;
      }
      offData();
      offComplete();
      client.close();
    },
  };
}

export function parseTraceCapture(
  capture: TraceCapture,
  kind: TraceKind,
): PerformanceCaptureResult {
  const marker = findClockMarker(capture.events, capture.markerName);
  if (kind.rendererScoped && !finite(marker?.pid)) {
    const reason = 'Extension trace marker did not identify a renderer process.';
    return {
      platform: capture.platform,
      javascript: unavailableJavaScriptSource('cdp-js-runtime-tasks', reason),
      nativeUi: unavailableNativeUiSource('cdp-native-frame-timings', reason),
      trace: traceEvidence(capture, 'unresolved'),
    };
  }
  const rendererProcessId = kind.rendererScoped ? marker?.pid : undefined;
  const scopedEvents =
    rendererProcessId === undefined
      ? capture.events
      : capture.events.filter((event) => event.pid === rendererProcessId);
  const trace = traceEvidence({ ...capture, events: scopedEvents }, kind.scope, rendererProcessId);
  if (
    !marker ||
    !finite(marker.ts) ||
    capture.markerHostEpochMs === undefined ||
    capture.markerUncertaintyMs === undefined
  ) {
    const reason = 'CDP trace clock marker was unavailable.';
    return {
      platform: capture.platform,
      javascript: unavailableJavaScriptSource('cdp-js-runtime-tasks', reason),
      nativeUi: unavailableNativeUiSource('cdp-native-frame-timings', reason),
      trace,
    };
  }

  const markerTs = marker.ts;
  const markerHostEpochMs = capture.markerHostEpochMs;
  const traceToEpochMs = (timestampUs: number) =>
    markerHostEpochMs + (timestampUs - markerTs) / 1000;
  const gapReasons = [
    ...capture.coverageGapReasons,
    ...(capture.overflow ? ['CDP trace retention limit was reached.'] : []),
    ...(capture.dataLossOccurred ? ['CDP reported trace data loss.'] : []),
  ];
  const nativeSamples = nativeFrameSamples(scopedEvents, kind.frameTiming, traceToEpochMs);
  const javascriptSamples = javascriptTaskSamples(scopedEvents, traceToEpochMs);
  const status: PerformanceSourceStatus =
    capture.overflow || capture.dataLossOccurred ? 'partial' : 'complete';

  return {
    platform: capture.platform,
    javascript: javascriptSourceResult(
      'cdp-js-runtime-tasks',
      javascriptSamples,
      status,
      gapReasons,
      traceEventNames(scopedEvents),
      capture.markerUncertaintyMs,
    ),
    nativeUi: nativeUiSourceResult(
      kind.nativeSource,
      nativeSamples,
      status,
      gapReasons,
      traceEventNames(scopedEvents),
      capture.markerUncertaintyMs,
    ),
    trace,
    rawTraceEvents: normalizeTraceTimestamps(scopedEvents, traceToEpochMs),
  };
}

function normalizeTraceTimestamps(
  events: readonly TraceEvent[],
  traceToEpochMs: (timestampUs: number) => number,
): TraceEvent[] {
  return events.map((event) =>
    finite(event.ts) ? { ...event, ts: traceToEpochMs(event.ts) * 1000 } : { ...event },
  );
}

function traceEvidence(
  capture: TraceCapture,
  scope: string,
  rendererProcessId?: number,
): TraceEvidence {
  const counts = new Map<string, number>();
  for (const event of capture.events) {
    const name = String(event.name ?? '');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return {
    beginFrameCount: counts.get('BeginFrame') ?? 0,
    dataLossOccurred: capture.dataLossOccurred,
    drawFrameCount: counts.get('DrawFrame') ?? 0,
    overflow: capture.overflow,
    profileChunkCount: counts.get('ProfileChunk') ?? 0,
    ...(rendererProcessId === undefined ? {} : { rendererProcessId }),
    runTaskCount: counts.get('RunTask') ?? 0,
    scope,
    totalEventCount: capture.events.length,
  };
}

function nativeFrameSamples(
  events: readonly TraceEvent[],
  frameTiming: TraceKind['frameTiming'],
  traceToEpochMs: (timestampUs: number) => number,
): FrameSample[] {
  const begins = new Map<string, TraceEvent>();
  const frames: { beginUs: number; endUs: number }[] = [];
  for (const event of events) {
    if (event.name !== 'BeginFrame' && event.name !== 'DrawFrame') continue;
    const sequence = frameSequence(event);
    if (!sequence || !finite(event.ts)) continue;
    if (event.name === 'BeginFrame') {
      begins.set(sequence, event);
      continue;
    }
    const begin = begins.get(sequence);
    if (!begin || !finite(begin.ts)) continue;
    frames.push({ beginUs: begin.ts, endUs: event.ts });
  }
  frames.sort((first, second) => first.beginUs - second.beginUs);
  const frameBudgetMs = estimateFrameBudgetMs(frames);

  if (frameTiming === 'cadence') {
    const samples: FrameSample[] = [];
    for (let index = 1; index < frames.length; index += 1) {
      const previous = frames[index - 1];
      const current = frames[index];
      if (!previous || !current) continue;
      const durationMs = (current.beginUs - previous.beginUs) / 1000;
      if (durationMs <= 0) continue;
      samples.push({
        cadenceInterval: true,
        completedAtEpochMs: traceToEpochMs(current.beginUs),
        durationMs,
        ...(frameBudgetMs
          ? {
              frameBudgetMs,
              overBudget: durationMs > frameBudgetMs * 1.01,
            }
          : {}),
        startedAtEpochMs: traceToEpochMs(previous.beginUs),
      });
    }
    return samples;
  }

  return frames
    .map((frame) => {
      const durationMs = (frame.endUs - frame.beginUs) / 1000;
      return {
        completedAtEpochMs: traceToEpochMs(frame.endUs),
        durationMs,
        ...(frameBudgetMs
          ? {
              frameBudgetMs,
              overBudget: durationMs > frameBudgetMs * 1.01,
            }
          : {}),
        startedAtEpochMs: traceToEpochMs(frame.beginUs),
      };
    })
    .filter((sample) => sample.durationMs > 0);
}

function estimateFrameBudgetMs(frames: readonly { beginUs: number }[]): number | undefined {
  const cadenceMs: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const current = frames[index];
    if (!previous || !current) continue;
    const intervalMs = (current.beginUs - previous.beginUs) / 1000;
    if (intervalMs >= 3.5 && intervalMs <= 40) cadenceMs.push(intervalMs);
  }
  if (cadenceMs.length < 5) return undefined;
  cadenceMs.sort((first, second) => first - second);
  const observedBudgetMs = percentile(cadenceMs, 0.1);
  const refreshRateHz = Math.round(1000 / observedBudgetMs);
  return refreshRateHz >= 24 && refreshRateHz <= 240 ? 1000 / refreshRateHz : undefined;
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

function javascriptTaskSamples(
  events: readonly TraceEvent[],
  traceToEpochMs: (timestampUs: number) => number,
): JavaScriptTaskSample[] {
  const samples: JavaScriptTaskSample[] = [];
  for (const event of events) {
    if (event.name !== 'RunTask' || event.ph !== 'X') continue;
    if (!finite(event.ts) || !finite(event.dur) || event.dur <= 0) continue;
    samples.push({
      completedAtEpochMs: traceToEpochMs(event.ts + event.dur),
      durationMs: event.dur / 1000,
    });
  }
  return samples;
}

function findClockMarker(
  events: readonly TraceEvent[],
  markerName?: string,
): TraceEvent | undefined {
  if (!markerName) return undefined;
  return events.find(
    (candidate) =>
      candidate.name === markerName ||
      asRecord(candidate.args).sync_id === markerName ||
      asRecord(asRecord(candidate.args).data).sync_id === markerName,
  );
}

function frameSequence(event: TraceEvent): string | undefined {
  const args = asRecord(event.args);
  const value = args.frameSeqId ?? asRecord(args.data).frameSeqId;
  return value === undefined ? undefined : String(value);
}

function javascriptSourceResult(
  kind: string,
  samples: JavaScriptTaskSample[],
  status: PerformanceSourceStatus,
  coverageGapReasons: string[],
  observedEventNames: string[],
  clockSyncUncertaintyMs: number,
): JavaScriptPerformanceSourceResult {
  return {
    applicability: 'applicable',
    status: samples.length > 0 ? status : 'partial',
    kind,
    unavailableReasons: [],
    coverageGapReasons: [
      ...coverageGapReasons,
      ...(samples.length > 0
        ? []
        : [
            `No ${kind} samples were recorded. Observed trace events: ${observedEventNames.join(', ') || 'none'}.`,
          ]),
    ],
    samples,
    summary: summarizeJavaScriptTasks(samples),
    clockSyncUncertaintyMs,
  };
}

function nativeUiSourceResult(
  kind: string,
  samples: FrameSample[],
  status: PerformanceSourceStatus,
  coverageGapReasons: string[],
  observedEventNames: string[],
  clockSyncUncertaintyMs: number,
): NativeUiPerformanceSourceResult {
  const summary = summarizeFrames(samples);
  const hasUnclassifiedCadenceGap = (summary.cadenceGapCount ?? 0) > 0;
  return {
    status: samples.length === 0 ? 'partial' : hasUnclassifiedCadenceGap ? 'partial' : status,
    kind,
    unavailableReasons: [],
    coverageGapReasons: [
      ...coverageGapReasons,
      ...(samples.length > 0
        ? []
        : [
            `No ${kind} samples were recorded. Observed trace events: ${observedEventNames.join(', ') || 'none'}.`,
          ]),
      ...(hasUnclassifiedCadenceGap
        ? ['Unclassified native cadence gap prevents a complete FPS result.']
        : []),
    ],
    samples,
    summary,
    clockSyncUncertaintyMs,
  };
}

function traceEventNames(events: readonly TraceEvent[]): string[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const name = String(event.name ?? 'unknown');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 20)
    .map(([name, count]) => `${name}(${count})`);
}

function unavailableJavaScriptSource(
  kind: string,
  reason: string,
): JavaScriptPerformanceSourceResult {
  return {
    applicability: 'applicable',
    status: 'unavailable',
    kind,
    unavailableReasons: [reason],
    coverageGapReasons: [],
    samples: [],
    summary: { taskCount: 0 },
  };
}

function unavailableNativeUiSource(kind: string, reason: string): NativeUiPerformanceSourceResult {
  return {
    status: 'unavailable',
    kind,
    unavailableReasons: [reason],
    coverageGapReasons: [],
    samples: [],
    summary: { frameCount: 0 },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
