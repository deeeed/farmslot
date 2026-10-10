import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { captureHelperPath } from '@farmslot/protocol/node/capture-helper-path';

import { RecipeExecutionError } from '../core/failure.js';
import type {
  ActiveVideoRecording,
  VideoRecorder,
  VideoRecorderDoctorResult,
  VideoRecorderStartRequest,
} from '../core/types.js';

import { createCaptureHelperVideoRecorder } from './capture-helper.js';
import { CAPTURE_INTERRUPTED } from './capture-helper-interruption.js';

const exec = promisify(execFile);

/** The caller must hold the device lease. This recorder owns only its scrcpy
 * process and exact window; it never installs, unlocks, or controls the device. */
export function createAndroidMirrorVideoRecorder(options: {
  serial: string;
  fallback: VideoRecorder;
  scrcpyPath?: string;
  captureHelperPath?: string;
}): VideoRecorder {
  const helperPath = options.captureHelperPath ?? captureHelperPath();
  const scrcpy = options.scrcpyPath ?? 'scrcpy';
  const primary = createCaptureHelperVideoRecorder({ captureHelperPath: helperPath });
  let selected: 'primary' | 'fallback' | undefined;
  let fallbackReason: string | undefined;
  async function doctor(): Promise<VideoRecorderDoctorResult> {
    selected = undefined;
    const native = await primary.doctor!();
    if (native.ok) {
      try {
        await exec(scrcpy, ['--version'], { timeout: 5000 });
        selected = 'primary';
        return {
          ok: true,
          code: 'ok',
          message:
            'Capture-helper and Android mirror are available; target readiness is checked at recording start.',
        };
      } catch (error) {
        fallbackReason = `Android mirror unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else fallbackReason = native.message;
    const result = (await options.fallback.doctor?.()) ?? {
      ok: true,
      code: 'ok',
      message: 'Fallback provider selected.',
    };
    if (result.ok) selected = 'fallback';
    return {
      ...result,
      message: `${result.message} Primary recording path unavailable: ${fallbackReason}`,
    };
  }
  return {
    name: 'android-recording',
    platform: 'android',
    doctor,
    async start(request: VideoRecorderStartRequest): Promise<ActiveVideoRecording> {
      if (request.target.kind !== 'android-device' || request.target.serial !== options.serial)
        throw new Error('Android recording target does not match the selected device.');
      if (!selected) {
        const result = await doctor();
        if (!result.ok) throw new Error(result.message);
      }
      if (selected === 'fallback') {
        const active = await options.fallback.start(request);
        return {
          ...active,
          async stop() {
            const result = await active.stop();
            return { ...result, recorder: { ...result.recorder, fallbackReason } };
          },
        };
      }
      const title = `Recipe recording ${randomUUID()}`;
      const child = spawn(
        scrcpy,
        ['--serial', options.serial, '--no-control', '--no-audio', '--window-title', title],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      let error: Error | undefined;
      let closing = false;
      let mirrorFailure: Error | undefined;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on('error', (failure) => {
        error = failure;
        if (!closing)
          mirrorFailure = new RecipeExecutionError('environment', failure.message, {
            code: CAPTURE_INTERRUPTED,
            cause: failure,
          });
      });
      const exited = new Promise<void>((resolve) => {
        child.once('exit', (code, signal) => {
          if (!closing)
            mirrorFailure = new RecipeExecutionError(
              'environment',
              `Owned Android mirror exited during recording (${signal ?? code}): ${stderr}`,
              { code: CAPTURE_INTERRUPTED },
            );
          resolve();
        });
        child.once('error', () => {
          if (child.pid === undefined) resolve();
        });
      });
      const waitForExit = (ms: number) =>
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), ms);
          void exited.then(() => {
            clearTimeout(timer);
            resolve(true);
          });
        });
      const cleanup = async () => {
        closing = true;
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          if (!(await waitForExit(5000))) {
            child.kill('SIGKILL');
            if (!(await waitForExit(5000)))
              throw new Error('Owned Android mirror did not exit after forced cleanup.');
          }
        }
      };
      try {
        let windowId: number | undefined;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if (error) throw error;
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`Android mirror exited: ${stderr}`);
          const list = await exec(helperPath, ['list', '--json'], {
            timeout: 5000,
            maxBuffer: 4 * 1024 * 1024,
          });
          const windows = JSON.parse(list.stdout).windows as {
            id: number;
            pid: number;
            title: string;
          }[];
          const owned = windows.find(
            (window) => window.pid === child.pid && window.title === title,
          );
          if (owned) {
            windowId = owned.id;
            break;
          }
          await delay(100);
        }
        if (windowId === undefined)
          throw new Error('The owned Android mirror did not expose a capture window.');
        const active = await primary.start({
          ...request,
          target: { kind: 'window-id', windowId: String(windowId) },
        });
        return {
          ...(active.snapshot
            ? {
                async snapshot(outputPath: string) {
                  if (mirrorFailure) throw mirrorFailure;
                  const result = await active.snapshot!(outputPath);
                  if (mirrorFailure) throw mirrorFailure;
                  return result;
                },
              }
            : {}),
          async stop() {
            try {
              const result = await active.stop();
              let interruption = result.interruption;
              if (mirrorFailure && !interruption) {
                // A normal helper stop can race the mirror's exit. Measured, finalized
                // frames still make this usable partial footage rather than a failed file.
                const frames = result.timing?.framesMs;
                if (!frames?.length) throw mirrorFailure;
                interruption = {
                  frames: frames.length,
                  mediaTimeMs: frames[frames.length - 1]!,
                  cause: mirrorFailure.message,
                };
              }
              return {
                ...result,
                ...(interruption ? { interruption } : {}),
                recorder: {
                  ...result.recorder,
                  platform: 'android',
                  target: { selector: 'adb-serial', value: options.serial },
                  mirrorWindowId: String(windowId),
                },
              };
            } finally {
              await cleanup();
            }
          },
        };
      } catch (failure) {
        await cleanup();
        throw failure;
      }
    },
  };
}
