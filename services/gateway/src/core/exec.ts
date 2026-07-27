// core/exec.ts — Local/remote command execution
// TypeScript port of lib/slot-common.sh: is_local, run_on, remote
// Uses node-rpc.ts for remote execution via connected nodes.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import type { ExecResult } from '@farmslot/protocol';

import { nodeExec } from '../fleet/node-rpc.js';

import type { SlotVars } from './config.js';

export type { ExecResult };

const LOCAL_HOSTNAME = os.hostname();

// Put asdf shims first in PATH so .tool-versions in cwd is respected.
const SHIMS_DIR = path.join(os.homedir(), '.asdf', 'shims');
// Strip FORCE_COLOR (inherited from concurrently/yarn dev wrapping the gateway).
// node `--print` honours FORCE_COLOR even when stdout is a pipe, wrapping output
// in ANSI escapes. That breaks shell scripts that match command output verbatim —
// notably the example-mobile VisionCamera podspec, which uses `node --print
// "require.resolve(...)"` and compares `output.strip == "undefined"`. With colour
// codes the strip fails, File.dirname returns ".", and pod install gets convinced
// FrameProcessors is enabled and dies looking for an unavailable pod spec. We
// drop FORCE_COLOR for ALL gateway-spawned shells; if a future caller explicitly
// needs colour they can set it back per-call (no current caller does).
const { FORCE_COLOR: _droppedForceColor, ...PROCESS_ENV_NO_FORCE_COLOR } = process.env;
void _droppedForceColor;
const LOCAL_ENV = { ...PROCESS_ENV_NO_FORCE_COLOR, PATH: `${SHIMS_DIR}:${process.env.PATH}` };

// ─── isLocal ───
// Mirrors bash is_local(): checks if host/machine refers to this machine.

export function isLocal(host: string, machine: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (machine === LOCAL_HOSTNAME) return true;
  if (host === `${LOCAL_HOSTNAME}.local`) return true;
  return false;
}

// ─── ExecOptions ───

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  onOutput?: (stream: string, data: string) => void;
  signal?: AbortSignal;
  maxBuffer?: number;
}

// ─── execLocal ───
// Run a command locally via child_process.spawn.
// When onOutput is provided, invokes it per chunk (streaming).
function execSpawn(command: string | string[], opts?: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const useProcessGroup = opts?.signal != null || opts?.timeout != null;
    const proc = Array.isArray(command)
      ? spawn(command[0], command.slice(1), {
          cwd: opts?.cwd,
          env: LOCAL_ENV,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: useProcessGroup,
        })
      : spawn('bash', ['-c', command], {
          cwd: opts?.cwd,
          env: LOCAL_ENV,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: useProcessGroup,
        });

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let maxBufferExceeded = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutEscalation: ReturnType<typeof setTimeout> | undefined;

    const killProcessTree = (sig: NodeJS.Signals) => {
      if (useProcessGroup && proc.pid) {
        try {
          process.kill(-proc.pid, sig);
          return;
        } catch (groupError) {
          try {
            proc.kill(sig);
            return;
          } catch (processError) {
            // Recovery is intentional: timeout/abort may race process exit, so both the
            // process group and child process can already be gone by the time this runs.
            console.warn(
              `[execLocal] ${sig} after process exit: group=${(groupError as Error).message}; process=${(processError as Error).message}`,
            );
            return;
          }
        }
      }
      proc.kill(sig);
    };

    const terminateWithEscalation = () => {
      killProcessTree('SIGTERM');
      timeoutEscalation = setTimeout(() => killProcessTree('SIGKILL'), 5000);
      timeoutEscalation.unref();
    };

    const appendOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
      const maxBuffer = opts?.maxBuffer;
      const nextOutputBytes = outputBytes + data.byteLength;
      let chunk = data;
      if (maxBuffer != null && nextOutputBytes > maxBuffer) {
        const remaining = Math.max(0, maxBuffer - outputBytes);
        chunk = remaining > 0 ? data.subarray(0, remaining) : Buffer.alloc(0);
        outputBytes = maxBuffer;
        if (!maxBufferExceeded) {
          maxBufferExceeded = true;
          stderr += `\nmaxBuffer exceeded after ${nextOutputBytes} bytes`;
          terminateWithEscalation();
        }
      } else {
        outputBytes = nextOutputBytes;
      }
      if (chunk.byteLength === 0) return;
      const str = chunk.toString();
      if (stream === 'stdout') stdout += str;
      else stderr += str;
      opts?.onOutput?.(stream, str);
    };

    let stdoutEnded = false;
    let stderrEnded = false;
    let processClosed = false;
    let resolved = false;
    let exitCode = 1;

    const tryResolve = () => {
      if (resolved || !processClosed || !stdoutEnded || !stderrEnded) return;
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (timeoutEscalation) clearTimeout(timeoutEscalation);
      resolve({ stdout, stderr, exitCode: timedOut ? 124 : maxBufferExceeded ? 1 : exitCode });
    };

    const markStreamClosed = (stream: 'stdout' | 'stderr') => {
      if (stream === 'stdout') stdoutEnded = true;
      else stderrEnded = true;
      tryResolve();
    };

    proc.stdout.on('data', (data: Buffer) => appendOutput('stdout', data));
    proc.stdout.on('end', () => markStreamClosed('stdout'));
    proc.stdout.on('close', () => markStreamClosed('stdout'));
    proc.stdout.on('error', (err) => {
      stderr += `\nstdout stream error: ${err.message}`;
      markStreamClosed('stdout');
    });

    proc.stderr.on('data', (data: Buffer) => appendOutput('stderr', data));
    proc.stderr.on('end', () => markStreamClosed('stderr'));
    proc.stderr.on('close', () => markStreamClosed('stderr'));
    proc.stderr.on('error', (err) => {
      stderr += `\nstderr stream error: ${err.message}`;
      markStreamClosed('stderr');
    });

    proc.on('close', (code) => {
      exitCode = code ?? 1;
      processClosed = true;
      tryResolve();
    });

    proc.on('error', (err) => {
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (timeoutEscalation) clearTimeout(timeoutEscalation);
      resolve({ stdout, stderr: stderr + `\nspawn error: ${err.message}`, exitCode: 1 });
    });

    if (opts?.timeout != null) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stderr += `\ncommand timed out after ${opts.timeout}ms`;
        terminateWithEscalation();
      }, opts.timeout);
      timeoutTimer.unref();
    }

    if (opts?.signal) {
      if (opts.signal.aborted) {
        terminateWithEscalation();
      } else {
        const onAbort = () => {
          terminateWithEscalation();
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        proc.on('close', () => {
          opts!.signal!.removeEventListener('abort', onAbort);
        });
      }
    }
  });
}

export function execLocal(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
  return execSpawn(cmd, opts);
}

export function execFileArgv(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
  if (argv.length === 0) throw new Error('argv must contain an executable');
  return execSpawn(argv, opts);
}

// ─── ExecOnSlotOptions ───

export type ExecOnSlotOptions = ExecOptions;

// ─── execOnSlot ───
// Run a command on the slot's host — locally or via agent-rpc.
// Mirrors bash remote() function.
// Accepts string 3rd arg (cwd) for backward compat, or options object.

export async function execOnSlot(
  slotVars: SlotVars,
  cmd: string,
  optsOrCwd?: string | ExecOnSlotOptions,
): Promise<ExecResult> {
  const opts: ExecOnSlotOptions =
    typeof optsOrCwd === 'string' ? { cwd: optsOrCwd } : (optsOrCwd ?? {});
  const cwd = opts.cwd ?? slotVars.remoteRepo;

  if (isLocal(slotVars.host, slotVars.machine)) {
    return execLocal(cmd, {
      cwd,
      timeout: opts.timeout,
      onOutput: opts.onOutput,
      signal: opts.signal,
      maxBuffer: opts.maxBuffer,
    });
  }
  // Note: signal is only supported for local execution. Remote cancellation
  // requires the node agent to support abort, which is not yet implemented.
  // For now, aborting a remote exec clears the activeReruns tracking but the
  // remote process may continue until its timeout expires.
  return nodeExec(slotVars.machine, cmd, cwd, {
    timeout: opts.timeout,
    onOutput: opts.onOutput,
    maxBuffer: opts.maxBuffer,
  });
}

export async function execArgvOnSlot(
  slotVars: SlotVars,
  argv: string[],
  opts: ExecOnSlotOptions = {},
): Promise<ExecResult> {
  if (argv.length === 0) throw new Error('argv must contain an executable');
  const cwd = opts.cwd ?? slotVars.remoteRepo;
  if (isLocal(slotVars.host, slotVars.machine)) {
    return execFileArgv(argv, { ...opts, cwd });
  }
  return nodeExec(slotVars.machine, argv, cwd, {
    timeout: opts.timeout,
    onOutput: opts.onOutput,
    maxBuffer: opts.maxBuffer,
  });
}
