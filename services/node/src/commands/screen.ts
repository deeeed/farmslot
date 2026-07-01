// screen.ts — Local screen capture for agent-mediated streaming
// Spawns capture-helper (iOS/browser) or adb screenrecord (Android) on the same machine.
// Frames are wrapped in a binary envelope (0xAF magic) and sent to the gateway.
//
// macOS: one capture-helper process per machine captures all windows (Simulator + browser).
// Windows are added/removed dynamically via stdin commands — zero disruption to existing streams.
// Android: per-slot adb screenrecord (unchanged).

import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

import { encodeNodeFrame } from '@farmslot/capabilities/screen-frame';
import { createH264FrameSplitter } from '@farmslot/capabilities/screen-h264';

import { captureHelperPath } from './capture-helper-path.js';
import { ensureLiveBrowserPid } from './screen-browser-pid.js';
import { buildStreamSink, createSinkStats, trackSinkFrame } from './screen-sinks.js';
export { screenshotForSlot } from './screen-screenshot.js';
import type {
  AndroidCapture,
  CaptureSink,
  MachineCapture,
  MacWindowSession,
  ProbeSink,
  RecordingSink,
  ScreenCaptureConfig,
  StartProbeParams,
  StartRecordingParams,
  TargetSelector,
} from './screen-types.js';
export type { ScreenCaptureConfig, StartProbeParams, StartRecordingParams };

const androidCaptures = new Map<string, AndroidCapture>();
let machineCapture: MachineCapture | null = null;
const MACOS_CAPTURE_WAIT_TIMEOUT_MS = 60_000;
const RECORDING_MAX_QUEUE_BYTES = 4 * 1024 * 1024;

let cachedCaptureHelperPath: string | null = null;

function resolvedCaptureHelperPath(): string {
  cachedCaptureHelperPath ??= captureHelperPath();
  return cachedCaptureHelperPath;
}

function log(action: string, slotId: string, detail?: string) {
  const parts = [`[screen] ${action} slot=${slotId}`];
  if (detail) parts.push(detail);
  console.log(parts.join(' '));
}

function captureKey(
  config: Pick<ScreenCaptureConfig, 'slotId' | 'resourceId' | 'platform'>,
): string {
  return `${config.slotId}:${config.resourceId ?? config.platform}`;
}

// --- Framed stdout parser (capture-helper --framed) ---
// Format: [4B len BE][1B flags][1B windowIndex][payload]
const FRAMED_HEADER_SIZE = 6;

function parseFramedStdout(mc: MachineCapture, chunk: Buffer): void {
  mc.buffer = Buffer.concat([mc.buffer, chunk]);
  while (mc.buffer.length >= FRAMED_HEADER_SIZE) {
    const payloadLen = mc.buffer.readUInt32BE(0);
    const totalLen = FRAMED_HEADER_SIZE + payloadLen;
    if (mc.buffer.length < totalLen) break;

    const flags = mc.buffer[4];
    const keyFrame = (flags & 1) !== 0;
    const windowIndex = mc.buffer[5];
    const payload = new Uint8Array(payloadLen);
    payload.set(
      new Uint8Array(mc.buffer.buffer, mc.buffer.byteOffset + FRAMED_HEADER_SIZE, payloadLen),
    );

    const targetKey = mc.windowIndexToTarget.get(windowIndex);
    if (targetKey) {
      const session = mc.sessions.get(targetKey);
      if (session) {
        emitMacSessionFrame(session, payload, keyFrame);
      }
    }

    mc.buffer = mc.buffer.subarray(totalLen);
  }
}

// --- Stderr parser ---

function wireMacOsStderr(proc: ChildProcess, mc: MachineCapture): void {
  let stderrBuf = '';
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        // Handle structured events from capture-helper
        if (msg.type === 'added') {
          const pending = mc.pendingAdd;
          if (pending) {
            mc.pendingAdd = null;
            const session: MacWindowSession = {
              targetKey: pending.targetKey,
              sessionId: `mac-capture-${++mc.nextSessionOrdinal}`,
              selector: pending.selector,
              maxFps: mc.maxFps,
              maxSize: mc.maxSize,
              windowIndex: msg.index,
              width: msg.width ?? 0,
              height: msg.height ?? 0,
              sinks: new Map(),
              lastPayload: null,
              lastKeyFrame: false,
            };
            mc.sessions.set(pending.targetKey, session);
            mc.windowIndexToTarget.set(msg.index, pending.targetKey);
            log(
              'added',
              pending.key,
              `index=${msg.index} ${msg.width}x${msg.height} session=${session.sessionId}`,
            );
            pending.resolve();
            drainAddQueue(mc);
          }
          continue;
        }

        if (msg.type === 'add_failed') {
          const pending = mc.pendingAdd;
          if (pending) {
            mc.pendingAdd = null;
            log('add-failed', pending.slotId, msg.error);
            pending.reject(new Error(msg.error ?? 'add failed'));
            drainAddQueue(mc);
          }
          continue;
        }

        if (msg.type === 'removed') {
          const targetKey = mc.windowIndexToTarget.get(msg.index);
          if (targetKey) {
            const session = mc.sessions.get(targetKey);
            if (session) {
              for (const sink of session.sinks.values()) {
                if (sink.sinkType === 'record') {
                  try {
                    sink.writer.destroy();
                  } catch {
                    /* ignore */
                  }
                }
                mc.sinkToTarget.delete(sink.key);
              }
              mc.sessions.delete(targetKey);
            }
            mc.windowIndexToTarget.delete(msg.index);
            log('removed-by-helper', targetKey, `index=${msg.index}`);
          }
          continue;
        }

        // Regular log messages
        console.log(`[screen] capture-helper: [${msg.type}] ${msg.msg}`);
      } catch {
        console.log(`[screen] capture-helper: ${line}`);
      }
    }
  });
}

function wireAndroidStderr(proc: ChildProcess, cap: AndroidCapture): void {
  let stderrBuf = '';
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        console.log(`[screen] capture slot=${cap.slotId}: [${msg.type}] ${msg.msg}`);
        const sizeMatch = msg.msg?.match(/output size: (\d+)x(\d+)/);
        if (sizeMatch) {
          cap.width = parseInt(sizeMatch[1], 10);
          cap.height = parseInt(sizeMatch[2], 10);
        }
      } catch {
        console.log(`[screen] capture slot=${cap.slotId}: ${line}`);
      }
    }
  });
}

// --- macOS capture-helper: single shared process ---

function windowCmd(config: ScreenCaptureConfig): string {
  if (config.targetPid) {
    return `+pid ${config.targetPid}`;
  }
  if ((config.platform === 'chrome-extension' || config.platform === 'web') && config.browserPid) {
    return `+pid ${config.browserPid}`;
  }
  if (config.windowAppName) {
    const title = config.iosWindowName ?? config.slotId;
    return `+match ${config.windowAppName}\t${title}`;
  }
  return `+name ${config.iosWindowName ?? config.slotId}`;
}

function selectorForConfig(config: ScreenCaptureConfig): TargetSelector {
  const selector: TargetSelector = { rawCommand: windowCmd(config) };
  if (config.targetPid) {
    selector.pid = config.targetPid;
    return selector;
  }
  if ((config.platform === 'chrome-extension' || config.platform === 'web') && config.browserPid) {
    selector.pid = config.browserPid;
    return selector;
  }
  selector.windowName = config.iosWindowName ?? config.slotId;
  if (config.windowAppName) {
    selector.appName = config.windowAppName;
  }
  return selector;
}

function findMacSession(
  mc: MachineCapture,
  selector: TargetSelector,
): MacWindowSession | undefined {
  const exact = mc.sessions.get(selector.rawCommand);
  if (exact) return exact;
  if (selector.pid != null) {
    return Array.from(mc.sessions.values()).find(
      (session) => session.selector.pid === selector.pid,
    );
  }
  if (selector.windowName && selector.appName) {
    return Array.from(mc.sessions.values()).find(
      (session) =>
        session.selector.windowName === selector.windowName &&
        session.selector.appName === selector.appName,
    );
  }
  if (selector.windowName) {
    const matches = Array.from(mc.sessions.values()).filter(
      (session) => session.selector.windowName === selector.windowName,
    );
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function isCaptureCompatible(
  owner: Pick<MachineCapture, 'maxFps' | 'maxSize'> | Pick<MacWindowSession, 'maxFps' | 'maxSize'>,
  requestedFps: number,
  requestedSize: number,
): boolean {
  return owner.maxFps === requestedFps && owner.maxSize === requestedSize;
}

function logRecordingDegrade(sink: RecordingSink, reason: string): void {
  console.warn(
    `[screen] record-degraded id=${sink.recordingId} fifo=${sink.fifoPath} reason=${reason} frames=${sink.stats.frames} bytes=${sink.stats.bytes} dropped=${sink.stats.droppedFrames} queueBytes=${sink.queueBytes}`,
  );
}

function clearRecordingTick(sink: RecordingSink): void {
  if (!sink.tickTimer) return;
  clearInterval(sink.tickTimer);
  sink.tickTimer = null;
}

function flushRecordingSink(sink: RecordingSink): void {
  while (!sink.backpressured && sink.queue.length > 0) {
    const chunk = sink.queue.shift()!;
    sink.queueBytes -= chunk.length;
    const ok = sink.writer.write(chunk);
    if (!ok) {
      sink.backpressured = true;
      sink.writer.once('drain', () => {
        sink.backpressured = false;
        flushRecordingSink(sink);
      });
      return;
    }
  }
}

function failRecordingSink(sink: RecordingSink, reason: string): void {
  if (sink.droppedDueToBackpressure) return;
  sink.droppedDueToBackpressure = true;
  clearRecordingTick(sink);
  logRecordingDegrade(sink, reason);
  try {
    sink.writer.destroy();
  } catch {
    /* ignore */
  }
}

function pushRecordingChunk(sink: RecordingSink, chunk: Buffer): void {
  sink.lastWriteAtMs = Date.now();
  trackSinkFrame(sink, chunk.length);
  if (sink.droppedDueToBackpressure) return;
  if (sink.backpressured) {
    if (sink.queueBytes + chunk.length > sink.maxQueueBytes) {
      sink.stats.droppedFrames += 1;
      failRecordingSink(sink, `record queue exceeded ${sink.maxQueueBytes} bytes`);
      return;
    }
    sink.queue.push(chunk);
    sink.queueBytes += chunk.length;
    return;
  }
  const ok = sink.writer.write(chunk);
  if (!ok) {
    sink.backpressured = true;
    sink.writer.once('drain', () => {
      sink.backpressured = false;
      flushRecordingSink(sink);
    });
  }
}

function ensureRecordingTick(sink: RecordingSink): void {
  if (sink.tickTimer) return;
  sink.tickTimer = setInterval(() => {
    if (sink.droppedDueToBackpressure || !sink.latestChunk) return;
    const now = Date.now();
    if (sink.lastWriteAtMs !== 0 && now - sink.lastWriteAtMs < sink.minFrameIntervalMs) return;
    pushRecordingChunk(sink, sink.latestChunk);
  }, sink.minFrameIntervalMs);
}

function updateRecordingFrame(sink: RecordingSink, payload: Uint8Array): void {
  sink.latestChunk = Buffer.from(payload);
  ensureRecordingTick(sink);
  if (sink.lastWriteAtMs === 0) {
    pushRecordingChunk(sink, sink.latestChunk);
  }
}

function emitMacSessionFrame(
  session: MacWindowSession,
  payload: Uint8Array,
  keyFrame: boolean,
): void {
  session.lastPayload = new Uint8Array(payload);
  session.lastKeyFrame = keyFrame;
  for (const sink of session.sinks.values()) {
    if (sink.sinkType === 'stream') {
      const frame = encodeNodeFrame(sink.slotId, payload, keyFrame, session.width, session.height);
      trackSinkFrame(sink, frame.length);
      sink.onFrame(frame);
      continue;
    }
    if (sink.sinkType === 'probe') {
      sink.lastFrameAtMs = Date.now();
      trackSinkFrame(sink, payload.length);
      continue;
    }
    updateRecordingFrame(sink, payload);
  }
}

function replayBootstrapFrame(session: MacWindowSession, sink: CaptureSink): void {
  if (!session.lastPayload) return;
  const payload = session.lastPayload;
  if (sink.sinkType === 'stream') {
    const frame = encodeNodeFrame(
      sink.slotId,
      payload,
      session.lastKeyFrame,
      session.width,
      session.height,
    );
    trackSinkFrame(sink, frame.length);
    sink.onFrame(frame);
    return;
  }
  if (sink.sinkType === 'probe') {
    sink.lastFrameAtMs = Date.now();
    trackSinkFrame(sink, payload.length);
    return;
  }
  updateRecordingFrame(sink, payload);
}

function attachSinkToSession(
  mc: MachineCapture,
  session: MacWindowSession,
  sink: CaptureSink,
): void {
  session.sinks.set(sink.key, sink);
  mc.sinkToTarget.set(sink.key, session.targetKey);
  log('sink-attach', sink.key, `session=${session.sessionId} type=${sink.sinkType}`);
  replayBootstrapFrame(session, sink);
}

function detachSinkByKey(mc: MachineCapture, sinkKey: string): void {
  const targetKey = mc.sinkToTarget.get(sinkKey);
  if (!targetKey) return;
  const session = mc.sessions.get(targetKey);
  mc.sinkToTarget.delete(sinkKey);
  if (!session) return;
  const sink = session.sinks.get(sinkKey);
  if (sink?.sinkType === 'record') {
    clearRecordingTick(sink);
    try {
      sink.writer.destroy();
    } catch {
      /* ignore */
    }
  }
  session.sinks.delete(sinkKey);
  log('sink-detach', sinkKey, `session=${session.sessionId}`);
  if (session.sinks.size > 0) return;
  mc.sessions.delete(targetKey);
  mc.windowIndexToTarget.delete(session.windowIndex);
  mc.proc.stdin!.write(`-${session.windowIndex}\n`);
  log('remove-window', targetKey, `index=${session.windowIndex} session=${session.sessionId}`);
  if (mc.sessions.size === 0 && !mc.pendingAdd) {
    log('stop', 'machine', 'no sessions left');
    try {
      mc.proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    machineCapture = null;
  }
}

function disposeMachineCapture(mc: MachineCapture): void {
  if (mc.pendingAdd) {
    mc.pendingAdd.reject(new Error('capture owner disposed'));
    mc.pendingAdd = null;
  }
  for (const queued of mc.addQueue) {
    queued.reject(new Error('capture owner disposed'));
  }
  mc.addQueue.length = 0;
  for (const session of mc.sessions.values()) {
    for (const sink of session.sinks.values()) {
      mc.sinkToTarget.delete(sink.key);
      if (sink.sinkType === 'record') {
        clearRecordingTick(sink);
        try {
          sink.writer.destroy();
        } catch {
          /* ignore */
        }
      }
    }
  }
  mc.sessions.clear();
  mc.sinkToTarget.clear();
  mc.windowIndexToTarget.clear();
}

function ensureMachineCapture(maxFps: number, maxSize: number): MachineCapture {
  if (machineCapture) {
    if (isCaptureCompatible(machineCapture, maxFps, maxSize)) {
      return machineCapture;
    }
    if (machineCapture.sessions.size === 0 && !machineCapture.pendingAdd) {
      const stale = machineCapture;
      machineCapture = null;
      disposeMachineCapture(stale);
      try {
        stale.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    } else {
      throw new Error(
        `shared capture already running at ${machineCapture.maxFps}fps/${machineCapture.maxSize}px; cannot satisfy ${maxFps}fps/${maxSize}px without a separate owner`,
      );
    }
  }

  log('spawn', 'machine', `fps=${maxFps} size=${maxSize}`);

  const proc = spawn(
    resolvedCaptureHelperPath(),
    ['stream', '--framed', '--max-fps', String(maxFps), '--max-size', String(maxSize)],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const mc: MachineCapture = {
    proc,
    maxFps,
    maxSize,
    sessions: new Map(),
    sinkToTarget: new Map(),
    windowIndexToTarget: new Map(),
    buffer: Buffer.alloc(0),
    pendingAdd: null,
    addQueue: [],
    nextSessionOrdinal: 0,
  };

  proc.stdout!.on('data', (chunk: Buffer) => parseFramedStdout(mc, chunk));
  wireMacOsStderr(proc, mc);

  proc.on('exit', (code) => {
    if (machineCapture?.proc === proc) {
      log('exit', 'machine', `code=${code} sessions=${mc.sessions.size}`);
      disposeMachineCapture(mc);
      machineCapture = null;
    }
  });

  machineCapture = mc;
  return mc;
}

async function addMacOsSink(
  config: ScreenCaptureConfig,
  sink: CaptureSink,
): Promise<{ sessionId: string; helperPid: number; targetKey: string }> {
  const { slotId, maxFps = 15, maxSize = 720 } = config;
  const mc = ensureMachineCapture(maxFps, maxSize);
  if ((config.platform === 'chrome-extension' || config.platform === 'web') && !config.targetPid) {
    const livePid = ensureLiveBrowserPid(config);
    if (livePid !== config.browserPid) {
      config = { ...config, browserPid: livePid };
    }
  }
  const selector = selectorForConfig(config);
  const existing = findMacSession(mc, selector);
  if (existing) {
    if (!isCaptureCompatible(existing, maxFps, maxSize)) {
      throw new Error(
        `existing shared session ${existing.sessionId} is ${existing.maxFps}fps/${existing.maxSize}px; requested ${maxFps}fps/${maxSize}px`,
      );
    }
    attachSinkToSession(mc, existing, sink);
    return {
      sessionId: existing.sessionId,
      helperPid: mc.proc.pid ?? 0,
      targetKey: existing.targetKey,
    };
  }

  if (
    mc.pendingAdd?.targetKey === selector.rawCommand ||
    mc.addQueue.some((entry) => entry.targetKey === selector.rawCommand)
  ) {
    log('dedupe-add', sink.key, `waiting for target=${selector.rawCommand}`);
    await waitForMacOsSession(mc, selector);
    const session = findMacSession(mc, selector);
    if (!session) throw new Error(`timed out waiting for capture ${selector.rawCommand}`);
    attachSinkToSession(mc, session, sink);
    return {
      sessionId: session.sessionId,
      helperPid: mc.proc.pid ?? 0,
      targetKey: session.targetKey,
    };
  }

  return new Promise<{ sessionId: string; helperPid: number; targetKey: string }>(
    (resolve, reject) => {
      mc.addQueue.push({
        config,
        targetKey: selector.rawCommand,
        selector,
        firstSink: sink,
        key: sink.key,
        slotId,
        resolve: () => {
          const session = findMacSession(mc, selector);
          if (!session) {
            reject(new Error(`capture added without session for ${selector.rawCommand}`));
            return;
          }
          attachSinkToSession(mc, session, sink);
          resolve({
            sessionId: session.sessionId,
            helperPid: mc.proc.pid ?? 0,
            targetKey: session.targetKey,
          });
        },
        reject,
      });
      drainAddQueue(mc);
    },
  );
}

function waitForMacOsSession(mc: MachineCapture, selector: TargetSelector): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (findMacSession(mc, selector)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > MACOS_CAPTURE_WAIT_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for capture ${selector.rawCommand}`));
      }
    }, 50);
  });
}

/** Serialize add-window commands: only send next when current pending resolves. */
function drainAddQueue(mc: MachineCapture): void {
  if (mc.pendingAdd || mc.addQueue.length === 0) return;
  const next = mc.addQueue.shift()!;
  log('add-window', next.slotId, next.selector.rawCommand);
  mc.pendingAdd = next;
  mc.proc.stdin!.write(`${next.selector.rawCommand}\n`);
}

function removeMacOsSink(key: string): void {
  if (!machineCapture) return;
  detachSinkByKey(machineCapture, key);
}

// --- Android spawn ---

function spawnAndroid(
  config: ScreenCaptureConfig,
  onFrame: (frame: Buffer) => void,
  restartCount = 0,
): AndroidCapture {
  const { slotId, maxSize = 720, androidSerial } = config;
  if (!androidSerial) throw new Error(`No Android serial for slot ${slotId}`);

  const sizeArg = `${maxSize}x${maxSize}`;
  log('spawn-android', slotId, `serial=${androidSerial} size=${maxSize} restart=${restartCount}`);

  const proc = spawn(
    'adb',
    [
      '-s',
      androidSerial,
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      '--size',
      sizeArg,
      '--bit-rate',
      '500000',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const cap: AndroidCapture = {
    proc,
    slotId,
    width: 0,
    height: 0,
    // Shared H.264 splitter (@farmslot/capabilities) encodes each frame and hands it off.
    // width/height are read live — they arrive on stderr after the first frames.
    h264: createH264FrameSplitter((payload, keyFrame) =>
      cap.onFrame(encodeNodeFrame(cap.slotId, payload, keyFrame, cap.width, cap.height)),
    ),
    onFrame,
    restartCount,
    config,
  };

  proc.stdout!.on('data', (chunk: Buffer) => cap.h264.push(chunk));

  wireAndroidStderr(proc, cap);

  proc.on('exit', (code) => {
    const current = androidCaptures.get(captureKey(config));
    if (current === cap) {
      const next = restartCount + 1;
      if (next >= 3) {
        log('error', slotId, `screenrecord exited code=${code}, max restarts reached`);
        androidCaptures.delete(captureKey(config));
        return;
      }
      log('restart', slotId, `screenrecord exited code=${code}, restarting (${next}/3)`);
      spawnAndroid(config, onFrame, next);
    }
  });

  androidCaptures.set(captureKey(config), cap);
  return cap;
}

// --- Public API ---

export async function startCapture(
  config: ScreenCaptureConfig,
  onFrame: (frame: Buffer) => void,
): Promise<void> {
  // Stop any existing capture for this slot first
  stopCapture(config);

  if (config.platform === 'android') {
    spawnAndroid(config, onFrame);
  } else {
    // iOS, chrome-extension, web — all go through shared capture-helper
    await addMacOsSink(config, buildStreamSink(captureKey(config), config.slotId, onFrame));
  }
}

export function stopCapture(configOrSlotId: ScreenCaptureConfig | string): void {
  const key =
    typeof configOrSlotId === 'string' ? `${configOrSlotId}:` : captureKey(configOrSlotId);
  // Check Android
  const androidCap = typeof configOrSlotId === 'string' ? null : androidCaptures.get(key);
  if (androidCap) {
    log('stop', key);
    androidCaptures.delete(key);
    try {
      androidCap.proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    return;
  }

  // Check macOS (shared capture-helper)
  if (!machineCapture) return;
  if (typeof configOrSlotId === 'string') {
    for (const existingKey of Array.from(machineCapture.sinkToTarget.keys())) {
      if (existingKey.startsWith(key)) removeMacOsSink(existingKey);
    }
    return;
  }
  removeMacOsSink(key);
}

export async function startMacOsRecording(
  params: StartRecordingParams,
): Promise<{ helperPid: number; sessionId: string; targetKey: string }> {
  const {
    recordingId,
    outputPath,
    windowName,
    appName,
    targetPid,
    maxFps = 15,
    maxSize = 720,
  } = params;
  if (!windowName && !targetPid) {
    throw new Error('recording requires windowName or targetPid');
  }
  if (process.platform !== 'darwin') {
    throw new Error('macOS recording control is only supported on darwin');
  }

  const sinkKey = `record:${recordingId}`;
  stopMacOsRecording(recordingId);

  const writer = createWriteStream(outputPath, { flags: 'w' });
  const sink: RecordingSink = {
    key: sinkKey,
    sinkType: 'record',
    slotId: recordingId,
    recordingId,
    fifoPath: outputPath,
    minFrameIntervalMs: Math.max(1, Math.floor(1000 / maxFps)),
    lastWriteAtMs: 0,
    latestChunk: null,
    tickTimer: null,
    writer,
    queue: [],
    queueBytes: 0,
    backpressured: false,
    maxQueueBytes: RECORDING_MAX_QUEUE_BYTES,
    stats: createSinkStats(),
    droppedDueToBackpressure: false,
  };

  writer.on('error', (err) => {
    logRecordingDegrade(sink, `writer error: ${err.message}`);
  });

  const config: ScreenCaptureConfig = {
    slotId: recordingId,
    platform: 'ios',
    maxFps,
    maxSize,
    ...(windowName ? { iosWindowName: windowName } : {}),
    ...(appName ? { windowAppName: appName } : {}),
    ...(targetPid ? { targetPid } : {}),
  };

  return addMacOsSink(config, sink);
}

export function stopMacOsRecording(recordingId: string): void {
  removeMacOsSink(`record:${recordingId}`);
}

export async function startMacOsProbe(
  params: StartProbeParams,
): Promise<{ helperPid: number; sessionId: string; targetKey: string }> {
  const { probeId, windowName, appName, targetPid, maxFps = 15, maxSize = 720 } = params;
  if (!windowName && !targetPid) {
    throw new Error('probe requires windowName or targetPid');
  }
  stopMacOsProbe(probeId);
  const config: ScreenCaptureConfig = {
    slotId: probeId,
    platform: 'ios',
    maxFps,
    maxSize,
    ...(windowName ? { iosWindowName: windowName } : {}),
    ...(appName ? { windowAppName: appName } : {}),
    ...(targetPid ? { targetPid } : {}),
  };
  const sink: ProbeSink = {
    key: `probe:${probeId}`,
    sinkType: 'probe',
    slotId: probeId,
    probeId,
    stats: createSinkStats(),
    lastFrameAtMs: 0,
  };
  return addMacOsSink(config, sink);
}

export function stopMacOsProbe(probeId: string): void {
  removeMacOsSink(`probe:${probeId}`);
}

export function getMacOsCaptureOwnerStatus(): {
  helperPid: number | null;
  sessionCount: number;
  sessions: Array<{
    sessionId: string;
    targetKey: string;
    sinks: Array<{
      key: string;
      type: string;
      frames: number;
      bytes: number;
      droppedFrames: number;
      lastFrameAtMs?: number;
    }>;
  }>;
} {
  return {
    helperPid: machineCapture?.proc.pid ?? null,
    sessionCount: machineCapture?.sessions.size ?? 0,
    sessions: machineCapture
      ? Array.from(machineCapture.sessions.values()).map((session) => ({
          sessionId: session.sessionId,
          targetKey: session.targetKey,
          sinks: Array.from(session.sinks.values()).map((sink) => ({
            key: sink.key,
            type: sink.sinkType,
            frames: sink.stats.frames,
            bytes: sink.stats.bytes,
            droppedFrames: sink.stats.droppedFrames,
            ...(sink.sinkType === 'probe' ? { lastFrameAtMs: sink.lastFrameAtMs } : {}),
          })),
        }))
      : [],
  };
}

export function stopAllCaptures(): void {
  // Android
  for (const [, cap] of androidCaptures) {
    try {
      cap.proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
  }
  androidCaptures.clear();

  // macOS
  if (machineCapture) {
    const mc = machineCapture;
    machineCapture = null;
    disposeMachineCapture(mc);
    try {
      mc.proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    machineCapture = null;
  }
}
