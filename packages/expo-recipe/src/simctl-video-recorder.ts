import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

import { errorMessage, manifestTarget } from '@farmslot/recipe-harness';
import type {
  ActiveVideoRecording,
  RecordingTarget,
  VideoRecorder,
  VideoRecorderDoctorResult,
  VideoRecorderStartRequest,
} from '@farmslot/recipe-harness';

const DEFAULT_STOP_TIMEOUT_MS = 20_000;

export interface SimctlVideoRecorderOptions {
  stopTimeoutMs?: number;
}

export function createSimctlVideoRecorder(options: SimctlVideoRecorderOptions = {}): VideoRecorder {
  return new SimctlVideoRecorder(options);
}

class SimctlVideoRecorder implements VideoRecorder {
  readonly name = 'simctl';
  readonly platform = 'ios';
  readonly #stopTimeoutMs: number;

  constructor(options: SimctlVideoRecorderOptions) {
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
    try {
      await runCommand('xcrun', ['simctl', 'help', 'io'], { timeoutMs: 10_000 });
    } catch (error) {
      return {
        ok: false,
        code: 'simctl_missing',
        message: `xcrun simctl is not available: ${errorMessage(error)}`,
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
    const args = ['simctl', 'io', device, 'recordVideo', '--codec=h264', '--force', request.outputPath];
    const child = spawn('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
            `simctl recordVideo exited early (${formatExit(code, signal)}): ${stderr.join('').trim()}`,
          ),
        );
      });
    });

    const stopTimeoutMs = this.#stopTimeoutMs;
    const target = request.target;
    return {
      async stop() {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGINT');
        const result = await waitForExit(exit, {
          timeoutMs: stopTimeoutMs,
          onTimeout: () => child.kill('SIGKILL'),
          message: `simctl recordVideo did not stop within ${stopTimeoutMs}ms after SIGINT.`,
        });
        const expectedInterrupt = result.signal === 'SIGINT';
        if (result.code !== 0 && !expectedInterrupt) {
          throw new Error(
            `simctl recordVideo failed (${formatExit(result.code, result.signal)}): ${stderr.join('').trim()}`,
          );
        }
        const stats = await stat(request.outputPath);
        if (stats.size <= 0) throw new Error(`Recording output is empty: ${request.outputPath}`);
        const bytes = await readFile(request.outputPath);
        if (!bytes.includes(Buffer.from('moov'))) {
          throw new Error(`Recording output is missing moov atom: ${request.outputPath}`);
        }
        return {
          recorder: {
            name: 'simctl',
            platform: 'ios',
            target: manifestTarget(target),
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