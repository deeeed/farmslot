import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { RecipeArtifactRecorderTarget } from '@farmslot/protocol';

import type {
  ActiveVideoRecording,
  RecordingTarget,
  VideoRecorder,
  VideoRecorderDoctorResult,
  VideoRecorderStartRequest,
} from '../core/types.js';

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
    this.#captureHelperPath =
      options.captureHelperPath ??
      resolveNativeCaptureHelperPath() ??
      commandPath('capture-helper') ??
      'capture-helper';
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
      return {
        ok: false,
        code: 'capture_helper_missing',
        message: `capture-helper is not available: ${errorMessage(error)}`,
        suggestedFix:
          'Install the external capture-helper tool (for example via Homebrew/npm) and ensure it is on PATH, or set CAPTURE_HELPER_PATH.',
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
    const args = ['record', ...targetArgs(request.target), '--output', request.outputPath];
    if (request.maxFps != null) args.push('--max-fps', String(request.maxFps));
    if (request.maxSize != null) args.push('--max-size', String(request.maxSize));

    const child = spawn(this.#captureHelperPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));
    child.stdout.resume();

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
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

    const getVersion = () => this.version;
    const stopTimeoutMs = this.#stopTimeoutMs;
    return {
      async stop() {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGINT');
        const result = await waitForExit(exit, {
          timeoutMs: stopTimeoutMs,
          onTimeout: () => child.kill('SIGKILL'),
          message: `capture-helper record did not stop within ${stopTimeoutMs}ms after SIGINT.`,
        });
        const expectedInterrupt = result.signal === 'SIGINT';
        if (result.code !== 0 && !expectedInterrupt) {
          throw new Error(
            `capture-helper record failed (${formatExit(result.code, result.signal)}): ${stderr.join('').trim()}`,
          );
        }
        const stats = await stat(request.outputPath);
        if (stats.size <= 0) throw new Error(`Recording output is empty: ${request.outputPath}`);
        return {
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
  if (target.kind === 'pid') return ['--pid', String(target.pid)];
  if (target.kind === 'window-id') return ['--window-id', target.windowId];
  if (target.kind === 'simulator') {
    throw new Error('capture-helper does not support simulator targets; use the simctl recorder.');
  }
  return ['--app-name', target.appName, '--window-name', target.windowName];
}

export function manifestTarget(target: RecordingTarget): RecipeArtifactRecorderTarget {
  if (target.kind === 'pid') return { selector: 'pid', value: String(target.pid) };
  if (target.kind === 'app-window') {
    return { selector: 'app-window', value: `${target.appName}:${target.windowName}` };
  }
  if (target.kind === 'simulator') {
    return { selector: 'simulator', value: target.device };
  }
  return { selector: 'window-id', value: target.windowId };
}

function resolveNativeCaptureHelperPath(): string | null {
  const candidates = [
    process.env.CAPTURE_HELPER_PATH,
    process.env.SITEED_CAPTURE_HELPER_BIN,
    process.env.HOME
      ? join(
          process.env.HOME,
          '.npm-global/lib/node_modules/@siteed/capture-helper/native/capture-helper',
        )
      : undefined,
    npmGlobalNativePath(),
    commandNativePath(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (candidate.endsWith('/node_modules/.bin/capture-helper')) continue;
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function npmGlobalNativePath(): string | null {
  const npm = commandPath('npm');
  if (!npm) return null;
  const result = spawnSync(npm, ['root', '-g'], { encoding: 'utf-8', timeout: 2_000 });
  const root = result.status === 0 ? result.stdout.trim() : '';
  return root ? join(root, '@siteed/capture-helper/native/capture-helper') : null;
}

function commandNativePath(): string | null {
  const bin = commandPath('capture-helper');
  if (!bin) return null;
  const real = safeRealpath(bin);
  if (!real?.endsWith('/bin/capture-helper.js')) return null;
  return join(dirname(dirname(real)), 'native/capture-helper');
}

function commandPath(command: string): string | null {
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // Expected for non-executable candidates while probing PATH/package locations.
    return false;
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // Expected for broken symlinks or disappearing PATH entries during best-effort probing.
    return null;
  }
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
