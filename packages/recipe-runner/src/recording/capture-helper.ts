import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { RecipeArtifactRecorderTarget } from '@farmslot/protocol';
import { captureHelperPath } from '@farmslot/protocol/node/capture-helper-path';

import type {
  ActiveVideoRecording,
  RecordingTarget,
  VideoRecorder,
  VideoRecorderDoctorResult,
  VideoRecorderStartRequest,
} from '../core/types.js';

import { readCaptureHelperTiming } from './capture-helper-timing.js';
import { optionalVideoTiming } from './timeline.js';

export interface CaptureHelperVideoRecorderOptions {
  captureHelperPath?: string;
  stopTimeoutMs?: number;
}

const DEFAULT_STOP_TIMEOUT_MS = 10_000;

interface CaptureHelperDoctorDocument {
  ok?: boolean;
  build?: { version?: string; name?: string; binary?: string };
  summary?: { requiredFailureCodes?: string[]; optionalFailureCodes?: string[] };
  checks?: Array<{ ok?: boolean; required?: boolean; code?: string; message?: string }>;
}

export function createCaptureHelperVideoRecorder(
  options: CaptureHelperVideoRecorderOptions = {},
): VideoRecorder {
  return new CaptureHelperVideoRecorder(options);
}

class CaptureHelperVideoRecorder implements VideoRecorder {
  readonly name = 'capture-helper';
  readonly platform = 'macos';
  readonly #captureHelperPath: string;
  readonly #stopTimeoutMs: number;
  #version: string | undefined;

  constructor(options: CaptureHelperVideoRecorderOptions) {
    this.#captureHelperPath = options.captureHelperPath ?? captureHelperPath();
    this.#stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  get version(): string | undefined {
    return this.#version;
  }

  async doctor(): Promise<VideoRecorderDoctorResult> {
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        code: 'unsupported_platform',
        message: 'capture-helper recording is macOS-only.',
        suggestedFix: 'Run on macOS or omit --record-video.',
      };
    }
    let result: CommandResult;
    try {
      result = await runCommand(this.#captureHelperPath, ['doctor', '--json'], {
        timeoutMs: 10_000,
      });
    } catch (error) {
      // Do NOT claim "not installed" — this only means spawn/exec failed (PATH, sandbox,
      // permissions, wrong CAPTURE_HELPER_PATH). Operators often have capture-helper on
      // PATH in interactive shells while the recipe child process does not.
      return {
        ok: false,
        code: 'capture_helper_exec_failed',
        message: `capture-helper doctor could not be executed (spawn/exec failed; not proof it is uninstalled): ${errorMessage(error)}`,
        suggestedFix:
          'Run `command -v capture-helper && capture-helper doctor --json` in this same environment. Ensure PATH includes the binary (e.g. ~/.npm-global/bin), or set CAPTURE_HELPER_PATH to the real binary. Unset a stale CAPTURE_HELPER_PATH if checksum_mismatch is reported.',
      };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'capture_helper_doctor_failed',
        message: result.stderr.trim() || result.stdout.trim() || 'capture-helper doctor failed.',
        suggestedFix: 'Run `capture-helper doctor --open-permissions` on the node host.',
      };
    }
    const parsed = parseDoctor(result.stdout);
    this.#version = parsed.build?.version;
    if (parsed.ok === false) {
      const failed = (parsed.checks ?? []).filter((check) => check.required && !check.ok);
      return {
        ok: false,
        code: failed[0]?.code ?? 'capture_helper_doctor_failed',
        message:
          failed
            .map((check) => check.message ?? check.code)
            .filter(Boolean)
            .join('; ') || 'capture-helper doctor reported required failures.',
        suggestedFix: 'Run `capture-helper doctor --open-permissions` on the node host.',
      };
    }
    return {
      ok: true,
      code: 'ok',
      message: `capture-helper${this.#version ? ` ${this.#version}` : ''} is ready.`,
    };
  }

  async start(request: VideoRecorderStartRequest): Promise<ActiveVideoRecording> {
    const versionResult = await runCommand(this.#captureHelperPath, ['version', '--json'], {
      timeoutMs: 10_000,
    });
    if (versionResult.exitCode !== 0) throw new Error('Capture-helper version probe failed.');
    const version = JSON.parse(versionResult.stdout);
    const nativeTiming =
      Array.isArray(version.capabilities) &&
      version.capabilities.includes('record_session_timing_v1');
    const sessionSnapshots =
      Array.isArray(version.capabilities) &&
      version.capabilities.includes('record_session_snapshot');
    const args = ['record', ...targetArgs(request.target), '--output', request.outputPath];
    if (sessionSnapshots) args.push('--framed');
    if (request.maxFps != null) args.push('--max-fps', String(request.maxFps));
    if (request.maxSize != null) args.push('--max-size', String(request.maxSize));

    const startedAtUnixMs = Date.now();
    const child = spawn(this.#captureHelperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    let ready = false;
    let eventBuffer = '';
    const snapshots = new Map<
      string,
      {
        resolve(event: Record<string, unknown>): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const usedSnapshotPaths = new Set<string>();
    let recordingId: string | undefined;
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderr.push(chunk);
      eventBuffer += chunk;
      const lines = eventBuffer.split('\n');
      eventBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; /* legacy helper diagnostics may be plain text */
        }
        if (
          event.type === 'record_ready' &&
          typeof event.recording_id === 'string' &&
          event.recording_id
        ) {
          recordingId = event.recording_id;
          ready = true;
        }
        const snapshot = typeof event.output === 'string' ? snapshots.get(event.output) : undefined;
        if (snapshot && ['snapshot', 'error'].includes(event.type)) {
          clearTimeout(snapshot.timer);
          snapshots.delete(event.output);
          if (
            event.type === 'snapshot' &&
            nativeTiming &&
            (event.recording_id !== recordingId ||
              typeof event.media_time_ms !== 'number' ||
              !Number.isFinite(event.media_time_ms) ||
              event.media_time_ms < 0 ||
              typeof event.source_time_ms !== 'number' ||
              !Number.isFinite(event.source_time_ms) ||
              typeof event.writer_accepted !== 'boolean' ||
              (event.writer_accepted &&
                (!Number.isInteger(event.writer_frame_index) || event.writer_frame_index < 0)))
          )
            snapshot.reject(
              new Error('Recording snapshot omitted valid timing or recording identity.'),
            );
          else if (event.type === 'snapshot')
            snapshot.resolve(
              nativeTiming
                ? event
                : {
                    ...event,
                    timingUnavailableReason: 'Recorder does not advertise snapshot timing.',
                  },
            );
          else snapshot.reject(new Error(event.message ?? 'Recording snapshot failed.'));
        }
      }
    });
    child.stdout.resume();

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => {
        for (const snapshot of snapshots.values()) {
          clearTimeout(snapshot.timer);
          snapshot.reject(new Error('Recorder exited before the snapshot completed.'));
        }
        snapshots.clear();
        resolve({ code, signal });
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, 250);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `capture-helper record exited early (${formatExit(code, signal)}): ${stderr.join('').trim()}`,
          ),
        );
      });
    });

    if (nativeTiming) {
      const deadline = Date.now() + 15_000;
      while (
        !ready &&
        child.exitCode === null &&
        child.signalCode === null &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!ready) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
        await waitForExit(exit, {
          timeoutMs: this.#stopTimeoutMs,
          onTimeout: () => child.kill('SIGKILL'),
          message: 'Capture-helper did not stop after readiness failure.',
        });
        throw new Error(
          `Capture-helper did not provide a recorded first frame: ${stderr.join('').trim()}`,
        );
      }
    }
    const getVersion = () => this.version;
    const stopTimeoutMs = this.#stopTimeoutMs;
    return {
      ...(sessionSnapshots
        ? {
            snapshot(outputPath: string): Promise<Record<string, unknown>> {
              if (/[\r\n]/.test(outputPath))
                return Promise.reject(new Error('Snapshot path cannot contain a newline.'));
              if (child.exitCode !== null || child.signalCode !== null)
                return Promise.reject(new Error('Recording is no longer active.'));
              if (usedSnapshotPaths.has(outputPath))
                return Promise.reject(
                  new Error('This snapshot path was already used in this recording.'),
                );
              usedSnapshotPaths.add(outputPath);
              return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  snapshots.delete(outputPath);
                  reject(new Error('Recording snapshot timed out.'));
                }, 15_000);
                snapshots.set(outputPath, { resolve, reject, timer });
                child.stdin.write(`snapshot ${outputPath}\n`, (error) => {
                  if (!error) return;
                  clearTimeout(timer);
                  snapshots.delete(outputPath);
                  reject(error);
                });
              });
            },
          }
        : {}),
      async stop() {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGINT');
        const result = await waitForExit(exit, {
          timeoutMs: stopTimeoutMs,
          onTimeout: () => child.kill('SIGKILL'),
          message: `capture-helper record did not stop within ${stopTimeoutMs}ms after SIGINT.`,
        });
        const expectedInterrupt = result.signal === 'SIGINT';
        const stoppedAtUnixMs = Date.now();
        if (result.code !== 0 && !expectedInterrupt) {
          throw new Error(
            `capture-helper record failed (${formatExit(result.code, result.signal)}): ${stderr.join('').trim()}`,
          );
        }
        const stats = await stat(request.outputPath);
        if (stats.size <= 0) throw new Error(`Recording output is empty: ${request.outputPath}`);
        return {
          ...(nativeTiming
            ? { timingEvidencePath: `${path.basename(request.outputPath)}.timing.json` }
            : {}),
          ...(nativeTiming
            ? await readCaptureHelperTiming(request.outputPath)
            : await optionalVideoTiming(request.outputPath, { startedAtUnixMs, stoppedAtUnixMs })),
          recorder: {
            name: 'capture-helper',
            ...(getVersion() ? { version: getVersion() } : {}),
            platform: 'macos',
            target: manifestTarget(request.target),
          },
        };
      },
    };
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function parseDoctor(stdout: string): CaptureHelperDoctorDocument {
  try {
    return JSON.parse(stdout) as CaptureHelperDoctorDocument;
  } catch (error) {
    throw new Error(`capture-helper doctor returned invalid JSON: ${errorMessage(error)}`);
  }
}

function waitForExit<T>(
  exit: Promise<T>,
  options: { timeoutMs: number; onTimeout: () => void; message: string },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      options.onTimeout();
      reject(new Error(options.message));
    }, options.timeoutMs);
    exit.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function targetArgs(target: RecordingTarget): string[] {
  if (target.kind === 'android-device')
    throw new Error('A physical Android recording requires the owned mirror recorder.');
  if (target.kind === 'pid') return ['--pid', String(target.pid)];
  if (target.kind === 'window-id') return ['--window-id', target.windowId];
  if (target.kind === 'simulator') {
    throw new Error('capture-helper does not support simulator targets; use the simctl recorder.');
  }
  return ['--app-name', target.appName, '--window-name', target.windowName];
}

export function manifestTarget(target: RecordingTarget): RecipeArtifactRecorderTarget {
  if (target.kind === 'android-device') return { selector: 'adb-serial', value: target.serial };
  if (target.kind === 'pid') return { selector: 'pid', value: String(target.pid) };
  if (target.kind === 'app-window') {
    return { selector: 'app-window', value: `${target.appName}:${target.windowName}` };
  }
  if (target.kind === 'simulator') {
    return { selector: 'simulator', value: target.device };
  }
  return { selector: 'window-id', value: target.windowId };
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
