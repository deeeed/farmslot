import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { CdpSession, selectCdpTarget, sleep } from '../runtime/cdp.js';
import type {
  ActiveVideoRecording,
  VideoRecorder,
  VideoRecorderDoctorResult,
  VideoRecorderStartRequest,
} from '../core/types.js';
import { errorMessage } from './capture-helper.js';

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
        message: `CDP Page.captureScreenshot ready (${bytes} bytes probe; capture-helper fallback).`,
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
    const target = await selectCdpTarget({
      host: this.#cdpHost,
      port: this.#cdpPort,
      type: 'page',
      urlIncludes: this.#urlIncludes,
    });
    if (!target.webSocketDebuggerUrl) {
      throw new Error('Selected CDP target has no webSocketDebuggerUrl.');
    }
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    await session.call('Page.enable');

    const fps = Math.min(Math.max(request.maxFps ?? 5, 1), 15);
    const framesDir = path.join(
      path.dirname(request.outputPath),
      `.cdp-frames-${path.basename(request.outputPath, path.extname(request.outputPath))}`,
    );
    await mkdir(framesDir, { recursive: true });

    let frameIndex = 0;
    let capturing = true;
    let captureError: Error | undefined;

    const captureLoop = (async () => {
      while (capturing) {
        const started = Date.now();
        try {
          const shot = await session.call<{ data?: string }>('Page.captureScreenshot', {
            format: 'png',
          });
          if (shot.data) {
            const framePath = path.join(
              framesDir,
              `frame_${String(frameIndex).padStart(6, '0')}.png`,
            );
            await writeFile(framePath, Buffer.from(shot.data, 'base64'));
            frameIndex += 1;
          }
        } catch (error) {
          captureError = error instanceof Error ? error : new Error(String(error));
          capturing = false;
          break;
        }
        const elapsed = Date.now() - started;
        await sleep(Math.max(0, Math.round(1000 / fps) - elapsed));
      }
    })();

    const ffmpegPath = this.#ffmpegPath;
    const outputPath = request.outputPath;
    const pageUrl = target.url ?? `cdp:${this.#cdpPort}`;

    return {
      async stop() {
        capturing = false;
        await captureLoop.catch(() => undefined);
        session.close();
        if (captureError) throw captureError;
        if (frameIndex === 0) {
          throw new Error('CDP recording captured zero frames.');
        }
        await encodePngSequenceToMp4({
          ffmpegPath,
          framesDir,
          outputPath,
          fps,
        });
        await rm(framesDir, { recursive: true, force: true });
        const stats = await stat(outputPath);
        if (stats.size <= 0) throw new Error(`Recording output is empty: ${outputPath}`);
        return {
          recorder: {
            name: 'cdp-screencast',
            platform: 'web',
            target: { selector: 'cdp-page', value: pageUrl },
          },
        };
      },
    };
  }
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
  fps,
}: {
  ffmpegPath: string;
  framesDir: string;
  outputPath: string;
  fps: number;
}): Promise<void> {
  const frames = (await readdir(framesDir)).filter((name) => name.endsWith('.png')).sort();
  if (frames.length === 0) throw new Error(`No PNG frames in ${framesDir}`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const inputPattern = path.join(framesDir, 'frame_%06d.png');
  await runCommand(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-framerate',
      String(fps),
      '-i',
      inputPattern,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
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