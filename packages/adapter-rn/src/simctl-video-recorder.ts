import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, watch } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type ActiveVideoRecording,
  errorMessage,
  manifestTarget,
  optionalVideoTiming,
  type RecordingTarget,
  type VideoRecorder,
  type VideoRecorderDoctorResult,
  type VideoRecorderStartRequest,
} from '@farmslot/recipe-runner';

import { createVisibleSimulatorRecorder } from './ios-window-recorder.js';

const START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 20_000;

export interface SimctlVideoRecorderOptions {
  stopTimeoutMs?: number;
  startTimeoutMs?: number;
}

export function createIosSimulatorVideoRecorder(
  simulator: string,
  options: SimctlVideoRecorderOptions = {},
): VideoRecorder {
  return createVisibleSimulatorRecorder(simulator, new SimctlVideoRecorder(simulator, options));
}

class SimctlVideoRecorder implements VideoRecorder {
  readonly name = 'simctl';
  readonly platform = 'ios';
  readonly #stopTimeoutMs: number;
  readonly #startTimeoutMs: number;
  readonly #simulator: string;

  constructor(simulator: string, options: SimctlVideoRecorderOptions) {
    this.#simulator = simulator;
    this.#startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  async doctor(): Promise<VideoRecorderDoctorResult> {
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        code: 'unsupported_platform',
        message: 'simctl recordVideo is macOS-only.',
        suggestedFix: 'Run iOS recipe proof on a macOS host or omit --record-video.',
      };
    }
    let result: CommandResult;
    try {
      result = await runCommand('xcrun', ['simctl', 'getenv', this.#simulator, 'SIMULATOR_UDID'], {
        timeoutMs: 10_000,
      });
    } catch (error) {
      return {
        ok: false,
        code: 'simctl_missing',
        message: `xcrun simctl is not available: ${errorMessage(error)}`,
        suggestedFix: 'Install Xcode command-line tools and ensure simctl is on PATH.',
      };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'simctl_help_failed',
        message: result.stderr.trim() || result.stdout.trim() || 'simctl help io failed.',
        suggestedFix: 'Install Xcode command-line tools and ensure simctl is on PATH.',
      };
    }
    return {
      ok: true,
      code: 'ok',
      message: 'simctl recordVideo is ready.',
    };
  }

  async start(request: VideoRecorderStartRequest): Promise<ActiveVideoRecording> {
    const device = simulatorDevice(request.target);
    if (device !== this.#simulator)
      throw new Error('Recording target differs from the selected simulator.');
    const args = [
      'simctl',
      'io',
      device,
      'recordVideo',
      '--codec=h264',
      '--force',
      request.outputPath,
    ];
    const startedAtUnixMs = Date.now();
    const logPath = `${request.outputPath}.simctl.log`;
    const log = openSync(logPath, 'w', 0o600);
    let child: ChildProcess;
    try {
      child = spawn('xcrun', args, { stdio: ['ignore', 'ignore', log] });
    } finally {
      closeSync(log);
    }
    const stderr = () => recordingLog(logPath);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: null, signal: null }));
    });
    try {
      await waitForRecordingStart(child, logPath, this.#startTimeoutMs);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
      await waitForExit(exit, {
        timeoutMs: this.#stopTimeoutMs,
        onTimeout: () => child.unref(),
        message: `${errorMessage(error)} SIGINT cleanup did not finish within ${this.#stopTimeoutMs}ms; recorder PID ${child.pid} is retained to avoid orphaning Simulator capture.`,
      });
      throw error;
    }

    const stopTimeoutMs = this.#stopTimeoutMs;
    const target = request.target;
    return {
      async stop() {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGINT');
        const result = await waitForExit(exit, {
          timeoutMs: stopTimeoutMs,
          onTimeout: () => child.unref(),
          message: `simctl recordVideo did not stop within ${stopTimeoutMs}ms after SIGINT; recorder PID ${child.pid} is retained to avoid orphaning Simulator capture.`,
        });
        const expectedInterrupt = result.signal === 'SIGINT';
        if (result.code !== 0 && !expectedInterrupt) {
          throw new Error(
            `simctl recordVideo failed (${formatExit(result.code, result.signal)}): ${stderr()}`,
          );
        }
        const stats = await stat(request.outputPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          throw new Error(
            `simctl recordVideo produced no file (${formatExit(result.code, result.signal)}): ${stderr().slice(-2000)}`,
          );
        });
        if (stats.size <= 0) throw new Error(`Recording output is empty: ${request.outputPath}`);
        const handle = await open(request.outputPath, 'r');
        let finalized = false;
        try {
          const size = Math.min(stats.size, 1_048_576);
          const head = Buffer.alloc(size);
          const tail = Buffer.alloc(size);
          await handle.read(head, 0, size, 0);
          await handle.read(tail, 0, size, Math.max(0, stats.size - size));
          finalized = head.includes(Buffer.from('moov')) || tail.includes(Buffer.from('moov'));
        } finally {
          await handle.close();
        }
        if (!finalized) {
          throw new Error(`Recording output is missing moov atom: ${request.outputPath}`);
        }
        return {
          segments: [
            {
              path: path.basename(request.outputPath),
              ...(await optionalVideoTiming(request.outputPath, {
                startedAtUnixMs,
                stoppedAtUnixMs: Date.now(),
              })),
              recorder: {
                name: 'simctl',
                platform: 'ios',
                target: manifestTarget(target),
              },
            },
          ],
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

function simulatorDevice(target: RecordingTarget): string {
  if (target.kind !== 'simulator') {
    throw new Error('simctl recorder requires a simulator recording target.');
  }
  return target.device;
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
}

// A regular staging log keeps an unresponsive client controllable after its caller exits.
function recordingLog(file: string, head = false): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 8192));
    const length = readSync(
      fd,
      buffer,
      0,
      buffer.length,
      head ? 0 : Math.max(0, size - buffer.length),
    );
    return buffer.subarray(0, length).toString('utf8').trim();
  } finally {
    closeSync(fd);
  }
}

function waitForRecordingStart(
  child: ChildProcess,
  logPath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(logPath);
    const timer = setTimeout(
      () =>
        finish(
          new Error(`simctl recordVideo did not report its first frame within ${timeoutMs}ms.`),
        ),
      timeoutMs,
    );
    const finish = (error?: Error) => {
      clearTimeout(timer);
      watcher.close();
      child.off('error', failed);
      child.off('exit', exited);
      if (error) reject(error);
      else resolve();
    };
    const failed = (error: Error) => finish(error);
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      try {
        finish(
          new Error(
            `simctl recordVideo exited early (${formatExit(code, signal)}): ${recordingLog(logPath)}`,
          ),
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const changed = () => {
      try {
        if (recordingLog(logPath, true).split(/\r?\n/u).includes('Recording started')) finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    watcher.on('change', changed);
    watcher.on('error', failed);
    child.once('error', failed);
    child.once('exit', exited);
    if (child.exitCode !== null || child.signalCode !== null)
      exited(child.exitCode, child.signalCode);
    else changed();
  });
}
