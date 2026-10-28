import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ActiveVideoRecording,
  VideoRecorder,
  VideoRecorderDoctorResult,
  VideoRecorderStartRequest,
  VideoRecordingSegment,
} from '../core/types.js';
import { CdpSession, selectCdpTarget, sleep } from '../runtime/cdp.js';

import { errorMessage } from './capture-helper.js';
import { type CapturedFrame, RecordingFrameSampler } from './frame-sampler.js';
import { optionalVideoTiming } from './timeline.js';

export interface CdpVideoRecorderOptions {
  cdpPort: number;
  cdpHost?: string;
  urlIncludes?: string;
  ffmpegPath?: string;
  /** Maintainer qualification can force short original segments without changing author recipes. */
  spoolBytes?: number;
}

export function createCdpVideoRecorder(options: CdpVideoRecorderOptions): VideoRecorder {
  return new CdpVideoRecorder(options);
}

class CdpVideoRecorder implements VideoRecorder {
  readonly name = 'cdp-screencast';
  readonly continuousSegments = true;
  readonly platform = 'web';
  readonly #cdpPort: number;
  readonly #cdpHost: string;
  readonly #urlIncludes: string | undefined;
  readonly #ffmpegPath: string;
  readonly #spoolBytes: number;

  constructor(options: CdpVideoRecorderOptions) {
    this.#cdpPort = options.cdpPort;
    this.#cdpHost = options.cdpHost ?? '127.0.0.1';
    this.#urlIncludes = options.urlIncludes;
    this.#ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.#spoolBytes = options.spoolBytes ?? 16 * 1024 * 1024;
    if (
      !Number.isInteger(this.#spoolBytes) ||
      this.#spoolBytes < 1 ||
      this.#spoolBytes > 16 * 1024 * 1024
    )
      throw new Error('CDP spoolBytes must be between 1 and 16 MiB.');
  }

  async doctor(): Promise<VideoRecorderDoctorResult> {
    try {
      const bytes = await probeCdpScreenshot(this.#cdpHost, this.#cdpPort, this.#urlIncludes);
      if (bytes < 64) {
        return {
          ok: false,
          code: 'cdp_screenshot_empty',
          message: 'CDP Page.captureScreenshot returned no image data.',
          suggestedFix: 'Ensure CDP Chrome is open on the recipe UI route.',
        };
      }
      return {
        ok: true,
        code: 'ok',
        message: `CDP Page.captureScreenshot ready (${bytes} bytes probe; browser capture).`,
      };
    } catch (error) {
      return {
        ok: false,
        code: 'cdp_unavailable',
        message: `CDP screenshot probe failed: ${errorMessage(error)}`,
        suggestedFix: 'Launch debug-chrome on the slot UI port before --record-video.',
      };
    }
  }

  async start(request: VideoRecorderStartRequest): Promise<ActiveVideoRecording> {
    const maxFps = request.maxFps ?? 15;
    if (!Number.isFinite(maxFps) || maxFps <= 0)
      throw new Error('Recording maxFps must be positive.');
    const spoolLimit = this.#spoolBytes;
    const recordingTarget = request.target;
    const target = await selectCdpTarget({
      host: this.#cdpHost,
      port: this.#cdpPort,
      type: 'page',
      urlIncludes: this.#urlIncludes,
      ...(recordingTarget.kind === 'cdp-page'
        ? { predicate: (target) => target.id === recordingTarget.targetId }
        : {}),
    });
    if (
      request.target.kind === 'cdp-page' &&
      (request.target.host !== this.#cdpHost || request.target.port !== this.#cdpPort)
    )
      throw new Error('CDP recording target belongs to a different endpoint.');
    if (!target.webSocketDebuggerUrl) throw new Error('Selected CDP target has no debugger URL.');
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    let framesDir: string;
    try {
      framesDir = await mkdtemp(path.join(path.dirname(request.outputPath), '.cdp-frames-'));
    } catch (error) {
      session.close();
      throw error;
    }
    let timestamps: number[] = [];
    let spoolBytes = 0;
    let pendingBytes = 0;
    let lastReceivedAt = 0;
    const segments: VideoRecordingSegment[] = [];
    const pendingAcks = new Set<Promise<unknown>>();
    let captureError: unknown;
    let receivedFrames = 0;
    let latestFrame: (CapturedFrame & { segmentIndex: number }) | undefined;
    const sampler = new RecordingFrameSampler(maxFps);
    let writeChain = Promise.resolve();
    let clock: { minOffsetMs: number; maxOffsetMs: number } | undefined;
    let clockError: string | undefined;
    try {
      clock = await measureBrowserClock(session);
    } catch (error) {
      clockError = `Recording clock unavailable: ${errorMessage(error)}`;
    }
    const ffmpegPath = this.#ffmpegPath;
    const flush = async (endSourceMs: number) => {
      if (!timestamps.length) return;
      const output =
        segments.length === 0
          ? request.outputPath
          : request.outputPath.replace(/\.mp4$/u, `-${segments.length}.mp4`);
      await encodePngSequenceToMp4({
        ffmpegPath,
        framesDir,
        outputPath: output,
        timestamps,
        lastFrameDurationMs: Math.max(1, endSourceMs - timestamps.at(-1)!),
      });
      const stats = await stat(output);
      if (!stats.size) throw new Error(`Recording output is empty: ${output}`);
      const timing = clock
        ? await optionalVideoTiming(output, {
            clock: {
              source: 'cdp-source-clock',
              earliestZeroUnixMs: timestamps[0]! - clock.maxOffsetMs,
              latestZeroUnixMs: timestamps[0]! - clock.minOffsetMs,
            },
          })
        : { timingUnavailableReason: clockError };
      segments.push({
        path: path.basename(output),
        ...timing,
        recorder: {
          name: 'cdp-screencast',
          platform: 'web',
          target: { selector: 'cdp-page', value: target.id },
        },
      });
      await rm(framesDir, { recursive: true, force: true });
      await mkdir(framesDir);
      timestamps = [];
      spoolBytes = 0;
    };
    const retain = async (frame: CapturedFrame) => {
      const bytes = Buffer.from(frame.data, 'base64');
      if (bytes.length > 16 * 1024 * 1024)
        throw new Error('A CDP frame exceeds the 16 MiB spool limit.');
      if (
        timestamps.length &&
        (spoolBytes + bytes.length > spoolLimit ||
          frame.timestampMs - timestamps[0]! >= 10 * 60 * 1000)
      )
        await flush(frame.timestampMs);
      const index = timestamps.length;
      await writeFile(path.join(framesDir, `frame_${String(index).padStart(6, '0')}.png`), bytes);
      timestamps.push(frame.timestampMs);
      spoolBytes += bytes.length;
      lastReceivedAt = frame.receivedAtUnixMs;
      latestFrame = { ...frame, segmentIndex: segments.length };
    };
    const unsubscribe = session.on('Page.screencastFrame', (params) => {
      const timestamp = (params.metadata as { timestamp?: number } | undefined)?.timestamp;
      const data = params.data;
      const receivedAtUnixMs = Date.now();
      const ack = session
        .call('Page.screencastFrameAck', { sessionId: params.sessionId })
        .catch((error) => {
          captureError = error;
        })
        .finally(() => pendingAcks.delete(ack));
      pendingAcks.add(ack);
      const queuedBytes = typeof data === 'string' ? Math.ceil((data.length * 3) / 4) : 0;
      // The frame is already acknowledged. Drop it until the encoder catches up.
      if (pendingBytes + queuedBytes > 16 * 1024 * 1024) return;
      pendingBytes += queuedBytes;
      writeChain = writeChain
        .then(async () => {
          if (captureError) return;
          if (
            typeof timestamp !== 'number' ||
            !Number.isFinite(timestamp) ||
            typeof data !== 'string'
          )
            throw new Error('CDP frame is missing its source timestamp or image.');
          const frame = { timestampMs: timestamp * 1000, receivedAtUnixMs, data };
          const ready = sampler.accept(frame);
          if (ready) await retain(ready);
          receivedFrames++;
        })
        .catch((error) => {
          captureError = error;
        })
        .finally(() => {
          pendingBytes -= queuedBytes;
        });
    });
    try {
      await session.call('Page.enable');
      await session.call('Page.startScreencast', {
        format: 'png',
        everyNthFrame: 1,
        ...(screencastMaxBounds(request.maxSize) ?? {}),
      });
      const deadline = Date.now() + 10_000;
      while (!receivedFrames && !captureError && Date.now() < deadline) await sleep(20);
      if (captureError) throw captureError;
      if (!receivedFrames) throw new Error('CDP recorder did not produce its first frame.');
    } catch (error) {
      unsubscribe();
      session.close();
      await writeChain;
      await rm(framesDir, { recursive: true, force: true });
      throw error;
    }
    let stopped = false;
    return {
      async snapshot(outputPath) {
        const snapshot = writeChain.then(async () => {
          if (stopped || captureError) throw new Error('CDP recording has no active source frame.');
          // A proof still pins this source frame before another repaint can replace it.
          const pending = sampler.finish();
          if (pending) await retain(pending);
          if (!latestFrame) throw new Error('CDP recording has no retained source frame.');
          const frame = latestFrame;
          await writeFile(outputPath, Buffer.from(frame.data, 'base64'));
          return {
            output: outputPath,
            provider: 'cdp-screencast',
            sourceTimestampMs: frame.timestampMs,
            segmentIndex: frame.segmentIndex,
          };
        });
        writeChain = snapshot.then(
          () => undefined,
          (error) => {
            // The caller receives this failure; stop retains usable originals as partial capture.
            captureError = error;
          },
        );
        return snapshot;
      },
      async stop() {
        if (stopped) throw new Error('CDP recording was already stopped.');
        stopped = true;
        const stoppedAtUnixMs = Date.now();
        unsubscribe();
        try {
          await Promise.all(pendingAcks);
          try {
            await session.call('Page.stopScreencast');
          } catch (error) {
            captureError ??= error;
          }
          await writeChain;
          const finalFrame = sampler.finish();
          try {
            if (finalFrame) await retain(finalFrame);
          } catch (error) {
            if (!segments.length) throw error;
            captureError ??= error;
          }
          const endSourceMs = captureError
            ? timestamps.at(-1)! + 1
            : clock
              ? stoppedAtUnixMs + (clock.minOffsetMs + clock.maxOffsetMs) / 2
              : timestamps.at(-1)! + Math.max(1, stoppedAtUnixMs - lastReceivedAt);
          try {
            await flush(endSourceMs);
          } catch (error) {
            if (!segments.length) throw error;
            captureError ??= error;
          }
          if (!segments.length)
            throw captureError ?? new Error('CDP recording has no finalized source segment.');
          return {
            segments,
            ...(captureError
              ? {
                  interruption: {
                    frames: segments.reduce(
                      (count, segment) => count + (segment.timing?.framesMs.length ?? 0),
                      0,
                    ),
                    mediaTimeMs: segments.at(-1)?.timing?.framesMs.at(-1) ?? 0,
                    cause: errorMessage(captureError),
                  },
                }
              : {}),
          };
        } finally {
          session.close();
          await rm(framesDir, { recursive: true, force: true });
        }
      },
    };
  }
}

async function measureBrowserClock(
  session: CdpSession,
): Promise<{ minOffsetMs: number; maxOffsetMs: number }> {
  const tree = await session.call<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
  const world = await session.call<{ executionContextId: number }>('Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id,
    worldName: 'recipe-recording-clock',
  });
  const before = Date.now();
  const result = await session.call<{ result: { value?: number } }>('Runtime.evaluate', {
    expression: 'Date.now()',
    contextId: world.executionContextId,
    returnByValue: true,
  });
  const after = Date.now();
  const remote = result.result.value;
  if (typeof remote !== 'number' || !Number.isFinite(remote))
    throw new Error('Browser clock sample is unavailable.');
  // Millisecond clock quantization contributes one millisecond at each bound.
  return { minOffsetMs: remote - after - 1, maxOffsetMs: remote - before + 1 };
}

function screencastMaxBounds(
  maxSize: number | undefined,
): { maxWidth: number; maxHeight: number } | undefined {
  if (maxSize == null || !Number.isFinite(maxSize) || maxSize <= 0) return undefined;
  const edge = Math.round(maxSize);
  return { maxWidth: edge, maxHeight: edge };
}

async function probeCdpScreenshot(
  host: string,
  port: number,
  urlIncludes: string | undefined,
): Promise<number> {
  const target = await selectCdpTarget({
    host,
    port,
    type: 'page',
    urlIncludes,
  });
  if (!target.webSocketDebuggerUrl) {
    throw new Error('CDP target missing webSocketDebuggerUrl.');
  }
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    await session.call('Page.enable');
    const shot = await session.call<{ data?: string }>('Page.captureScreenshot', {
      format: 'png',
    });
    return shot.data ? Buffer.from(shot.data, 'base64').length : 0;
  } finally {
    session.close();
  }
}

async function encodePngSequenceToMp4({
  ffmpegPath,
  framesDir,
  outputPath,
  timestamps,
  lastFrameDurationMs,
}: {
  ffmpegPath: string;
  framesDir: string;
  outputPath: string;
  timestamps: number[];
  lastFrameDurationMs: number;
}): Promise<void> {
  if (!timestamps.length) throw new Error('No CDP frames captured.');
  await mkdir(path.dirname(outputPath), { recursive: true });
  // ffconcat preserves variable capture intervals. The last repeated image
  // holds the final captured state through stop; it is not another observation.
  const file = (index: number) => `frame_${String(index).padStart(6, '0')}.png`;
  const rows = timestamps.map((timestamp, index) => {
    const durationMs =
      index + 1 < timestamps.length ? timestamps[index + 1]! - timestamp : lastFrameDurationMs;
    return `file '${file(index)}'\noption framerate 1000\nduration ${(durationMs / 1000).toFixed(6)}`;
  });
  rows.push(`file '${file(timestamps.length - 1)}'\noption framerate 1000`);
  const listPath = path.join(framesDir, 'frames.ffconcat');
  await writeFile(listPath, `ffconcat version 1.0\n${rows.join('\n')}\n`);
  await runCommand(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-fps_mode',
      'vfr',
      '-c:v',
      process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264',
      ...(process.platform === 'darwin' ? ['-allow_sw', '0'] : ['-preset', 'ultrafast']),
      '-b:v',
      '1000000',
      '-maxrate',
      '1000000',
      '-bufsize',
      '2000000',
      '-fs',
      String(100 * 1024 * 1024),
      '-bf',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-video_track_timescale',
      '1000000',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    { timeoutMs: 120_000 },
  );
}

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}
