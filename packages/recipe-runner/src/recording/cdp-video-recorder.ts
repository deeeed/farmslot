import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ActiveVideoRecording,
  VideoRecorder,
  VideoRecorderDoctorResult,
  VideoRecorderStartRequest,
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
}

export function createCdpVideoRecorder(options: CdpVideoRecorderOptions): VideoRecorder {
  return new CdpVideoRecorder(options);
}

class CdpVideoRecorder implements VideoRecorder {
  readonly name = 'cdp-screencast';
  readonly platform = 'web';
  readonly #cdpPort: number;
  readonly #cdpHost: string;
  readonly #urlIncludes: string | undefined;
  readonly #ffmpegPath: string;

  constructor(options: CdpVideoRecorderOptions) {
    this.#cdpPort = options.cdpPort;
    this.#cdpHost = options.cdpHost ?? '127.0.0.1';
    this.#urlIncludes = options.urlIncludes;
    this.#ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
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
    const maxFps = request.maxFps ?? 30;
    if (!Number.isFinite(maxFps) || maxFps <= 0)
      throw new Error('Recording maxFps must be positive.');
    const target = await selectCdpTarget({
      host: this.#cdpHost,
      port: this.#cdpPort,
      type: 'page',
      urlIncludes: this.#urlIncludes,
    });
    if (!target.webSocketDebuggerUrl) throw new Error('Selected CDP target has no debugger URL.');
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    let framesDir: string;
    try {
      framesDir = await mkdtemp(path.join(path.dirname(request.outputPath), '.cdp-frames-'));
    } catch (error) {
      session.close();
      throw error;
    }
    const timestamps: number[] = [];
    let lastReceivedAt = 0;
    const pendingAcks = new Set<Promise<unknown>>();
    let captureError: unknown;
    let receivedFrames = 0;
    const sampler = new RecordingFrameSampler(maxFps);
    let writeChain = Promise.resolve();
    let clock: { minOffsetMs: number; maxOffsetMs: number } | undefined;
    let clockError: string | undefined;
    try {
      clock = await measureBrowserClock(session);
    } catch (error) {
      clockError = `Recording clock unavailable: ${errorMessage(error)}`;
    }
    const retain = async (frame: CapturedFrame): Promise<void> => {
      const index = timestamps.length;
      timestamps.push(frame.timestampMs);
      lastReceivedAt = frame.receivedAtUnixMs;
      await writeFile(
        path.join(framesDir, `frame_${String(index).padStart(6, '0')}.png`),
        Buffer.from(frame.data, 'base64'),
      );
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
      writeChain = writeChain
        .then(async () => {
          if (
            typeof timestamp !== 'number' ||
            !Number.isFinite(timestamp) ||
            typeof data !== 'string'
          )
            throw new Error('CDP frame is missing its source timestamp or image.');
          const ready = sampler.accept({ timestampMs: timestamp * 1000, receivedAtUnixMs, data });
          if (ready) await retain(ready);
          receivedFrames++;
        })
        .catch((error) => {
          captureError = error;
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
    const ffmpegPath = this.#ffmpegPath;
    let stopped = false;
    return {
      async stop() {
        if (stopped) throw new Error('CDP recording was already stopped.');
        stopped = true;
        const stoppedAtUnixMs = Date.now();
        unsubscribe();
        try {
          await Promise.all(pendingAcks);
          await session.call('Page.stopScreencast');
          await writeChain;
          if (captureError) throw captureError;
          const finalFrame = sampler.finish();
          if (finalFrame) await retain(finalFrame);
          if (clock) {
            try {
              const endClock = await measureBrowserClock(session);
              clock.minOffsetMs = Math.min(clock.minOffsetMs, endClock.minOffsetMs);
              clock.maxOffsetMs = Math.max(clock.maxOffsetMs, endClock.maxOffsetMs);
            } catch (error) {
              clockError = `Recording end clock unavailable: ${errorMessage(error)}`;
              clock = undefined;
            }
          }
          await encodePngSequenceToMp4({
            ffmpegPath,
            framesDir,
            outputPath: request.outputPath,
            timestamps,
            lastFrameDurationMs: Math.max(
              1,
              clock
                ? stoppedAtUnixMs + (clock.minOffsetMs + clock.maxOffsetMs) / 2 - timestamps.at(-1)!
                : stoppedAtUnixMs - lastReceivedAt,
            ),
          });
          const stats = await stat(request.outputPath);
          if (stats.size <= 0) throw new Error(`Recording output is empty: ${request.outputPath}`);
          // A CDP first frame can predate startScreencast. Use its source clock,
          // calibrated through an isolated world, rather than process lifetime.
          const timing = clock
            ? await optionalVideoTiming(request.outputPath, {
                clock: {
                  source: 'cdp-source-clock',
                  earliestZeroUnixMs: timestamps[0]! - clock.maxOffsetMs,
                  latestZeroUnixMs: timestamps[0]! - clock.minOffsetMs,
                },
              })
            : { timingUnavailableReason: clockError };
          return {
            ...timing,
            recorder: {
              name: 'cdp-screencast',
              platform: 'web',
              target: { selector: 'cdp-page', value: target.url ?? `cdp:${request.nodeId}` },
            },
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
      'libx264',
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
