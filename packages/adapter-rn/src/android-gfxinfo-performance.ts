// Android native UI frames for a performance capture: polls
// `adb shell dumpsys gfxinfo <package> framestats` from the host, maps the
// device uptime clock onto the host clock, and summarizes the merged frames
// with recipe-runner's frame metrics. The frames that handled input keep that
// mark, so a host can time a press from the touch to the frame that answers it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  clockMidpoint,
  estimateRefreshBudgetMs,
  type FrameSample,
  type JavaScriptPerformanceSourceResult,
  type NativeUiPerformanceSourceResult,
  type PerformanceBackend,
  type PerformanceCaptureResult,
  type PerformanceSourceStatus,
  summarizeFrames,
  type TraceClockSync,
  type TraceEvent,
} from '@farmslot/recipe-runner/runtime/cdp-trace';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 750;
const MAX_FRAMES = 100_000;
const GFXINFO_FRAME_BUFFER_SIZE = 120;
const GFXINFO_SAFE_NEW_FRAME_LIMIT = Math.floor(GFXINFO_FRAME_BUFFER_SIZE * 0.9);

export interface AndroidGfxinfoPerformanceOptions {
  /** adb serial of the device. */
  serial: string;
  /** Application id whose frames are read, e.g. `com.example.app`. */
  packageId: string;
  /** adb binary; `adb` on PATH by default. */
  adbPath?: string;
}

/** A gfxinfo frame: a recipe-runner frame sample plus what the UI thread did in it. */
export interface AndroidFrameSample extends FrameSample {
  startedAtEpochMs: number;
  /** The frame handled an input event (a touch or key reached the app in it). */
  input?: true;
  /** UI-thread time from the frame's vsync until it handed the frame to the render thread. */
  uiThreadMs?: number;
}

export interface AndroidGfxinfoCaptureResult extends PerformanceCaptureResult<'android'> {
  nativeUi: NativeUiPerformanceSourceResult & { samples: AndroidFrameSample[] };
  /** `missing` when the device's framestats has no InputEventId column (before Android 12). */
  inputEvents: 'available' | 'missing';
}

/** What a report says about the device and app it measured. */
export interface AndroidDeviceDescription {
  serial: string;
  model?: string;
  androidRelease?: string;
  packageId: string;
  versionName?: string;
  versionCode?: string;
  /** `debug` when the installed package is debuggable. */
  buildType?: 'debug' | 'release';
  lastUpdateTime?: string;
}

export interface AndroidGfxinfoPerformanceBackend extends PerformanceBackend<'android'> {
  end(id: string): Promise<AndroidGfxinfoCaptureResult>;
  describe?(): Promise<AndroidDeviceDescription>;
}

export interface AndroidFrameRow {
  completedNs: number;
  deadlineNs: number;
  frameIntervalNs: number;
  inputEventId: string;
  intendedVsyncNs: number;
  syncQueuedNs: number;
  vsyncId: string;
  vsyncNs: number;
}

interface ActiveCapture {
  clock: AndroidClockSync;
  coverageGapReasons: string[];
  frames: Map<string, AndroidFrameRow>;
  inputEventsMissing: boolean;
  id: string;
  poll: Promise<void>;
  polling: boolean;
  timer?: NodeJS.Timeout;
}

export interface AndroidClockSync {
  hostEpochAtDeviceUptimeMs: number;
  uncertaintyMs: number;
}

interface ParsedFrameStats {
  bufferCapacityReached: boolean;
  frames: AndroidFrameRow[];
  /** False when a framestats header had no InputEventId column. */
  inputEventColumn: boolean;
}

export function createAndroidGfxinfoPerformanceBackend(
  options: AndroidGfxinfoPerformanceOptions,
): AndroidGfxinfoPerformanceBackend {
  const serial = options.serial.trim();
  const packageId = options.packageId.trim();
  if (!serial) throw new Error('Android performance capture requires the device adb serial.');
  if (!packageId) throw new Error('Android performance capture requires the app package id.');
  const adb = options.adbPath ?? 'adb';
  let active: ActiveCapture | undefined;

  return {
    async start(id) {
      if (active) {
        throw new Error('Only one Android performance trace may be active.');
      }
      const clock = await synchronizeAndroidClock(adb, serial, packageId);
      await adbCommand(adb, serial, ['shell', 'dumpsys', 'gfxinfo', packageId, 'reset']);
      const capture: ActiveCapture = {
        clock,
        coverageGapReasons: [],
        frames: new Map(),
        inputEventsMissing: false,
        id,
        poll: Promise.resolve(),
        polling: false,
      };
      active = capture;
      capture.timer = setInterval(() => queuePoll(capture), POLL_INTERVAL_MS);
    },
    async end(id) {
      const capture = active;
      if (!capture || capture.id !== id) {
        throw new Error(`Performance capture is not active: ${id}`);
      }
      if (capture.timer) clearInterval(capture.timer);
      await capture.poll;
      await queuePoll(capture);
      active = undefined;
      return captureResult(capture);
    },
    async close() {
      const capture = active;
      if (!capture) return;
      if (capture.timer) clearInterval(capture.timer);
      await capture.poll;
      await queuePoll(capture);
      active = undefined;
    },
    async describe() {
      const [model, androidRelease, packageInfo] = await Promise.all(
        [
          ['shell', 'getprop', 'ro.product.model'],
          ['shell', 'getprop', 'ro.build.version.release'],
          ['shell', 'dumpsys', 'package', packageId],
        ].map((args) => adbCommand(adb, serial, args).catch(() => '')),
      );
      const field = (name: string) =>
        new RegExp(`\\b${name}=([^\\s]+)`, 'u').exec(packageInfo ?? '')?.[1];
      const lastUpdateTime = /lastUpdateTime=([^\n]+)/u.exec(packageInfo ?? '')?.[1]?.trim();
      const flags = /pkgFlags=\[([^\]]*)\]/u.exec(packageInfo ?? '')?.[1];
      return {
        serial,
        packageId,
        ...(model?.trim() ? { model: model.trim() } : {}),
        ...(androidRelease?.trim() ? { androidRelease: androidRelease.trim() } : {}),
        ...(field('versionName') ? { versionName: field('versionName') } : {}),
        ...(field('versionCode') ? { versionCode: field('versionCode') } : {}),
        ...(flags === undefined
          ? {}
          : {
              buildType: flags.includes('DEBUGGABLE') ? ('debug' as const) : ('release' as const),
            }),
        ...(lastUpdateTime ? { lastUpdateTime } : {}),
      };
    },
  };

  function queuePoll(capture: ActiveCapture): Promise<void> {
    if (capture.polling) return capture.poll;
    capture.polling = true;
    capture.poll = (async () => {
      try {
        const output = await adbCommand(adb, serial, [
          'shell',
          'dumpsys',
          'gfxinfo',
          packageId,
          'framestats',
        ]);
        const parsed = parseFrameStats(output);
        capture.inputEventsMissing ||= !parsed.inputEventColumn;
        let newFrameCount = 0;
        for (const frame of parsed.frames) {
          if (capture.frames.size >= MAX_FRAMES) {
            addGap(capture, 'Android frame retention limit was reached.');
            break;
          }
          const key = `${frame.vsyncId}:${frame.vsyncNs}`;
          if (!capture.frames.has(key)) newFrameCount += 1;
          capture.frames.set(key, frame);
        }
        if (parsed.bufferCapacityReached && newFrameCount >= GFXINFO_SAFE_NEW_FRAME_LIMIT) {
          addGap(capture, 'Android gfxinfo may have overwritten frames between polls.');
        }
      } catch (error) {
        addGap(capture, `Android gfxinfo poll failed: ${errorMessage(error).slice(0, 180)}`);
      }
    })().finally(() => {
      capture.polling = false;
    });
    return capture.poll;
  }
}

function captureResult(capture: ActiveCapture): AndroidGfxinfoCaptureResult {
  const rows = [...capture.frames.values()].sort(
    (first, second) => first.intendedVsyncNs - second.intendedVsyncNs,
  );
  const fallbackBudgetMs = estimateFrameBudgetMs(rows);
  const samples = rows.map((row) => androidFrameSample(row, capture.clock, fallbackBudgetMs));
  const noFrames = samples.length === 0;
  const status: PerformanceSourceStatus = noFrames
    ? 'unavailable'
    : capture.coverageGapReasons.length > 0
      ? 'partial'
      : 'complete';
  const unavailableReasons = noFrames ? ['No Android gfxinfo frame samples were recorded.'] : [];
  const coverageGapReasons = [...capture.coverageGapReasons];
  const rawTraceEvents = buildAndroidFrameTraceEvents(rows, capture.clock, fallbackBudgetMs);
  return {
    platform: 'android',
    javascript: notApplicableJavaScript(),
    nativeUi: {
      status,
      kind: 'android-gfxinfo-framestats',
      unavailableReasons,
      coverageGapReasons,
      samples,
      summary: summarizeFrames(samples),
      clockSyncUncertaintyMs: capture.clock.uncertaintyMs,
    },
    trace: {
      beginFrameCount: rows.length,
      dataLossOccurred: coverageGapReasons.length > 0,
      drawFrameCount: rows.length,
      overflow: capture.frames.size >= MAX_FRAMES,
      profileChunkCount: 0,
      runTaskCount: 0,
      scope: 'mobile-host',
      totalEventCount: rawTraceEvents.length,
    },
    rawTraceEvents,
    inputEvents: capture.inputEventsMissing ? 'missing' : 'available',
  };
}

export function androidFrameSample(
  row: AndroidFrameRow,
  clock: AndroidClockSync,
  fallbackBudgetMs: number | undefined,
): AndroidFrameSample {
  const measurement = frameMeasurement(row, fallbackBudgetMs);
  const startedAtEpochMs = clock.hostEpochAtDeviceUptimeMs + row.intendedVsyncNs / 1_000_000;
  return {
    completedAtEpochMs: startedAtEpochMs + measurement.durationMs,
    durationMs: measurement.durationMs,
    ...(measurement.frameBudgetMs ? { frameBudgetMs: measurement.frameBudgetMs } : {}),
    ...(measurement.overBudget === undefined ? {} : { overBudget: measurement.overBudget }),
    startedAtEpochMs,
    ...(row.inputEventId !== '0' ? { input: true as const } : {}),
    ...(row.syncQueuedNs > row.intendedVsyncNs
      ? { uiThreadMs: (row.syncQueuedNs - row.intendedVsyncNs) / 1_000_000 }
      : {}),
  };
}

export function parseFrameStats(output: string): ParsedFrameStats {
  const frames: AndroidFrameRow[] = [];
  let bufferCapacityReached = false;
  let columnsByName: Map<string, number> | undefined;
  let sectionRowCount = 0;
  let sawHeader = false;
  let inputEventColumn = true;
  for (const line of output.split(/\r?\n/u)) {
    if (line === '---PROFILEDATA---') {
      bufferCapacityReached ||= sectionRowCount >= GFXINFO_FRAME_BUFFER_SIZE;
      columnsByName = undefined;
      sectionRowCount = 0;
      continue;
    }
    if (line.startsWith('Flags,')) {
      columnsByName = new Map(line.split(',').map((name, index) => [name.trim(), index]));
      sawHeader = true;
      inputEventColumn &&= columnsByName.has('InputEventId');
      const missing = ['Flags', 'IntendedVsync', 'Vsync', 'FrameCompleted'].filter(
        (name) => !columnsByName?.has(name),
      );
      if (missing.length > 0) {
        throw new Error(
          `Unsupported Android gfxinfo framestats header; missing ${missing.join(', ')}.`,
        );
      }
      continue;
    }
    if (!/^\d+,/u.test(line)) continue;
    if (!columnsByName) continue;
    const columns = line.split(',');
    sectionRowCount += 1;
    if (Number(column(columns, columnsByName, 'Flags')) !== 0) continue;
    const intendedVsyncNs = Number(column(columns, columnsByName, 'IntendedVsync'));
    const vsyncNs = Number(column(columns, columnsByName, 'Vsync'));
    const deadlineNs = Number(column(columns, columnsByName, 'FrameDeadline') ?? 0);
    const frameIntervalNs = Number(column(columns, columnsByName, 'FrameInterval') ?? 0);
    const completedNs = Number(column(columns, columnsByName, 'FrameCompleted'));
    if (
      !positiveFinite(intendedVsyncNs) ||
      !positiveFinite(vsyncNs) ||
      !positiveFinite(completedNs) ||
      completedNs <= intendedVsyncNs
    ) {
      continue;
    }
    const syncQueuedNs = Number(column(columns, columnsByName, 'SyncQueued') ?? 0);
    frames.push({
      completedNs,
      deadlineNs,
      frameIntervalNs,
      inputEventId: (column(columns, columnsByName, 'InputEventId') ?? '0').trim() || '0',
      intendedVsyncNs,
      syncQueuedNs: Number.isFinite(syncQueuedNs) ? syncQueuedNs : 0,
      vsyncId: String(column(columns, columnsByName, 'FrameTimelineVsyncId') ?? intendedVsyncNs),
      vsyncNs,
    });
  }
  bufferCapacityReached ||= sectionRowCount >= GFXINFO_FRAME_BUFFER_SIZE;
  if (output.includes('---PROFILEDATA---') && !sawHeader) {
    throw new Error('Android gfxinfo framestats header was not found.');
  }
  return { bufferCapacityReached, frames, inputEventColumn };
}

function column(
  columns: readonly string[],
  columnsByName: ReadonlyMap<string, number>,
  name: string,
): string | undefined {
  const index = columnsByName.get(name);
  return index === undefined ? undefined : columns[index];
}

export function buildAndroidFrameTraceEvents(
  rows: readonly AndroidFrameRow[],
  clock: AndroidClockSync,
  fallbackBudgetMs: number | undefined,
): TraceEvent[] {
  return rows.flatMap((row, index) => {
    const measurement = frameMeasurement(row, fallbackBudgetMs);
    const args = {
      frameSeqId: row.vsyncId || String(index),
      durationMs: measurement.durationMs,
      ...(measurement.frameBudgetMs ? { frameBudgetMs: measurement.frameBudgetMs } : {}),
      ...(measurement.overBudget === undefined
        ? {}
        : {
            overBudget: measurement.overBudget,
            overBudgetClassification: measurement.classification,
          }),
      ...(measurement.classification === 'frame-deadline'
        ? { frameDeadlineMissed: measurement.overBudget }
        : {}),
      source: 'android-gfxinfo',
    };
    const intendedVsyncEpochUs =
      (clock.hostEpochAtDeviceUptimeMs + row.intendedVsyncNs / 1_000_000) * 1000;
    const completedEpochUs = (clock.hostEpochAtDeviceUptimeMs + row.completedNs / 1_000_000) * 1000;
    return [
      {
        name: 'BeginFrame',
        cat: 'disabled-by-default-devtools.timeline.frame',
        ph: 'I',
        ts: intendedVsyncEpochUs,
        pid: 1,
        tid: 1,
        args,
      },
      {
        name: 'DrawFrame',
        cat: 'disabled-by-default-devtools.timeline.frame',
        ph: 'I',
        ts: completedEpochUs,
        pid: 1,
        tid: 1,
        args,
      },
    ];
  });
}

function frameMeasurement(
  row: AndroidFrameRow,
  fallbackBudgetMs: number | undefined,
): {
  classification?: 'frame-deadline' | 'refresh-budget';
  durationMs: number;
  frameBudgetMs?: number;
  overBudget?: boolean;
} {
  const durationMs = (row.completedNs - row.intendedVsyncNs) / 1_000_000;
  const frameBudgetMs =
    row.frameIntervalNs > 0 ? row.frameIntervalNs / 1_000_000 : fallbackBudgetMs;
  if (row.deadlineNs > row.intendedVsyncNs) {
    return {
      classification: 'frame-deadline',
      durationMs,
      ...(frameBudgetMs ? { frameBudgetMs } : {}),
      overBudget: row.completedNs > row.deadlineNs,
    };
  }
  return {
    ...(frameBudgetMs
      ? {
          classification: 'refresh-budget' as const,
          frameBudgetMs,
          overBudget: durationMs > frameBudgetMs * 1.01,
        }
      : {}),
    durationMs,
  };
}

async function synchronizeAndroidClock(
  adb: string,
  serial: string,
  packageId: string,
): Promise<AndroidClockSync> {
  const { value: output, ...midpoint } = await clockMidpoint(() =>
    adbCommand(adb, serial, ['shell', 'dumpsys', 'gfxinfo', packageId, 'framestats']),
  );
  const deviceUptimeMs = Number(/Uptime:\s+(\d+)/u.exec(output)?.[1]);
  return androidClockSync(midpoint, deviceUptimeMs);
}

/** The host epoch of device uptime 0, from the host-clock midpoint of the read that printed `Uptime:`. */
export function androidClockSync(
  midpoint: TraceClockSync,
  deviceUptimeMs: number,
): AndroidClockSync {
  if (!positiveFinite(deviceUptimeMs)) {
    throw new Error('Android performance capture could not read device uptime.');
  }
  return {
    hostEpochAtDeviceUptimeMs: midpoint.hostEpochMs - deviceUptimeMs,
    uncertaintyMs: midpoint.uncertaintyMs,
  };
}

async function adbCommand(adb: string, serial: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(adb, ['-s', serial, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  });
  return stdout;
}

function estimateFrameBudgetMs(rows: readonly AndroidFrameRow[]): number | undefined {
  return estimateRefreshBudgetMs(rows.map((row) => row.intendedVsyncNs / 1_000_000));
}

function notApplicableJavaScript(): JavaScriptPerformanceSourceResult {
  return {
    applicability: 'not_applicable',
    status: 'unavailable',
    kind: 'not-applicable-mobile-js-tasks',
    unavailableReasons: [],
    coverageGapReasons: [],
    samples: [],
    summary: {},
  };
}

function addGap(capture: ActiveCapture, reason: string): void {
  if (!capture.coverageGapReasons.includes(reason)) {
    capture.coverageGapReasons.push(reason);
  }
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
