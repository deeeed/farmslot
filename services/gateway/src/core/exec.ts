// core/exec.ts — Local/remote command execution
// TypeScript port of lib/slot-common.sh: is_local, run_on, remote
// Uses node-rpc.ts for remote execution via connected nodes.
import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNodeExecCloseout, type ExecResult, observeNodeExecAbort } from '@farmslot/protocol';
import { currentProjectSources, sourceExecutionEnvironment } from '@farmslot/slot-config';

import { currentFarmPaths, farmPathsForSlot } from '../fleet/farm-paths.js';
import { getNode } from '../fleet/machine-registry.js';
import { usesNodeLink } from '../fleet/node-link-policy.js';
import { nodeExec, nodeExecArgv } from '../fleet/node-rpc.js';
import { executionKind, measureManagedOperation } from '../observability/performance.js';

import { assertCleanupCurrent, cleanupSignal, trackCleanupCommand } from './cleanup-scope.js';
import type { SlotVars } from './config.js';
import { currentSlotCommandExecutor } from './exec-scope.js';
import { commandIncludesRemotePath } from './remote-paths.js';

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

/** In-process task libraries inherit the same boot-time environment as local commands. */
export function localCommandEnvironment(): NodeJS.ProcessEnv {
  const paths = currentFarmPaths('gateway');
  return {
    ...LOCAL_ENV,
    FARMSLOT_HOME: paths.home,
    FARMSLOT_POOL_DIR: paths.pool,
    FARMSLOT_PROJECTS_DIR: paths.projects,
  };
}

// ─── isLocal ───
// Mirrors bash is_local(): checks if host/machine refers to this machine.

export function isLocal(host: string, machine: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (machine === LOCAL_HOSTNAME) return true;
  if (host === `${LOCAL_HOSTNAME}.local`) return true;
  return false;
}

/**
 * Whether a slot's files can be read in-process instead of through a shell: the routing
 * `execOnSlot` would give a command to this machine is a plain local shell, with no workspace
 * owner or project sources that must vet each command.
 */
export function slotFilesReadInProcess(slotVars: Pick<SlotVars, 'host' | 'machine'>): boolean {
  assertCleanupCurrent();
  return (
    !currentSlotCommandExecutor() &&
    !currentProjectSources() &&
    isLocal(slotVars.host, slotVars.machine) &&
    !usesNodeLink(slotVars.machine)
  );
}

/** A remote slot machine with no connected node: commands sent to it now fail. */
export function isDisconnectedRemote(vars: Pick<SlotVars, 'host' | 'machine'>): boolean {
  return (
    (!isLocal(vars.host, vars.machine) || usesNodeLink(vars.machine)) && !getNode(vars.machine)
  );
}

// ─── ExecOptions ───

/**
 * Exit status reported when a command exhausts its `timeout` budget.
 *
 * Callers that must tell "the probe ran out of time" from "the probe answered"
 * branch on this rather than on the timeout sentence appended to stderr.
 */
export const EXEC_TIMEOUT_EXIT_CODE = 124;

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  onOutput?: (stream: string, data: string) => void;
  signal?: AbortSignal;
  closeoutTimeoutMs?: number;
  maxBuffer?: number;
  /** Remote only: fail instead of resending a command whose reply was lost. */
  noRetry?: boolean;
}

// ─── Process groups ───

/**
 * A process that owns every local command it starts: the gateway-background process, whose
 * commands must not outlive it. Each command gets its own process group and is handed to
 * `started`, so the owner can kill the group of any command that has not exited when it exits.
 * Each also carries a guard (GUARD_PRELUDE) that kills its group if the owner dies outright.
 */
export interface LocalCommandOwner {
  started(command: ChildProcess): void;
  /** The owner's pid, which each command's guard watches. */
  pid: number;
}
let localCommandOwner: LocalCommandOwner | undefined;

export function ownLocalCommands(owner: LocalCommandOwner | undefined): void {
  localCommandOwner = owner;
}

/**
 * Run as `sh -c PRELUDE sh <owner pid> <executable> <argv...>` (POSIX sh: dash on Linux). A guard
 * subshell joins the command's process group, then the shell execs the command, which keeps the
 * shell's pid: the exit status, signal, output and group are the command's own. Once a second the
 * guard exits if the command (`$$`, the parent shell's pid, now the command's) is gone, and
 * SIGKILLs its own group (`kill 0`) if the owner is gone, however the owner died.
 * - It ignores TERM (in the subshell only, so the command's own dispositions are untouched): the
 *   owner's timeout sends TERM to the group, and the guard must outlive that until KILL.
 * - It only ever signals its own group, whose id is not reused while the guard is in it.
 * - A reused owner pid can only look alive and delay the kill (a leak in a rare case); a pid that
 *   now belongs to another user fails `kill -0`, which is right, as the owner is then gone.
 * - Its stdio is /dev/null, so it never holds the command's pipes.
 */
const GUARD_PRELUDE =
  'o=$1; shift; (trap \'\' TERM; while kill -0 "$$" 2>/dev/null; do kill -0 "$o" 2>/dev/null || kill -KILL 0; sleep 1; done) </dev/null >/dev/null 2>&1 & exec "$@"';

/**
 * Whether the prelude's `exec` runs what spawn would: an existing cwd, and an executable spawn
 * would find (a path, or a name on the command's PATH). Otherwise the command starts unwrapped, so
 * its spawn error stays exactly today's.
 */
function preludeRunsExactly(executable: string, cwd: string | undefined, envPath: string): boolean {
  const accessible = (file: string, kind: 'directory' | 'executable') => {
    try {
      if (kind === 'directory') return statSync(file).isDirectory();
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch (error) {
      // Missing or not permitted: spawn would fail too, and reports it in its own words.
      if (
        ['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        return false;
      throw error;
    }
  };
  const base = cwd === undefined ? process.cwd() : path.resolve(cwd);
  if (cwd !== undefined && !accessible(base, 'directory')) return false;
  if (executable.includes('/')) return accessible(path.resolve(base, executable), 'executable');
  return envPath
    .split(':')
    .some((directory) =>
      accessible(path.resolve(base, directory || '.', executable), 'executable'),
    );
}

/** Signals every process in a command's group; false when none is left (ESRCH). */
export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    // The group's processes have all exited: there is nothing left to signal.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

// ─── execLocal ───
// Run a command locally via child_process.spawn.
// When onOutput is provided, invokes it per chunk (streaming).
export function execLocal(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
  return execSpawn('bash', ['-c', cmd], opts);
}

export function execFileArgv(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
  if (argv.length === 0) throw new Error('exec argv must contain at least one element');
  return execSpawn(argv[0], argv.slice(1), opts);
}

async function execSpawn(
  executable: string,
  argv: string[],
  opts?: ExecOptions,
): Promise<ExecResult> {
  assertCleanupCurrent();
  opts = { ...opts, signal: cleanupSignal(opts?.signal) };
  if (opts?.signal?.aborted)
    return Promise.resolve({
      stdout: '',
      stderr: 'Command cancelled before execution.',
      exitCode: 130,
    });
  return measureManagedOperation('exec', executionKind(executable, argv), () =>
    spawnLocalProcess(executable, argv, opts),
  );
}

function spawnLocalProcess(
  executable: string,
  argv: string[],
  opts?: ExecOptions,
): Promise<ExecResult> {
  return trackCleanupCommand(
    new Promise((resolve) => {
      const owner = localCommandOwner;
      const useProcessGroup = owner !== undefined || opts?.signal != null || opts?.timeout != null;
      const env = localCommandEnvironment();
      // A command that would fail to start runs unwrapped: it fails as spawn reports it, and
      // leaves no process to guard.
      const guarded =
        owner !== undefined && preludeRunsExactly(executable, opts?.cwd, env.PATH ?? '');
      const proc = guarded
        ? spawn('/bin/sh', ['-c', GUARD_PRELUDE, 'sh', String(owner.pid), executable, ...argv], {
            cwd: opts?.cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          })
        : spawn(executable, argv, {
            cwd: opts?.cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: useProcessGroup,
          });
      if (proc.pid !== undefined) owner?.started(proc);

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let maxBufferExceeded = false;
      let timedOut = false;
      let aborted = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const group = useProcessGroup ? proc.pid : undefined;

      const killProcessTree = (sig: NodeJS.Signals) => {
        if (group !== undefined) {
          let groupError: string;
          try {
            if (signalProcessGroup(group, sig)) return;
            groupError = 'no process left in the group';
          } catch (error) {
            groupError = (error as Error).message;
          }
          try {
            proc.kill(sig);
            return;
          } catch (processError) {
            console.warn(
              `[execSpawn] ${sig} after process exit: group=${groupError}; process=${(processError as Error).message}`,
            );
            return;
          }
        }
        proc.kill(sig);
      };
      const closeout = createNodeExecCloseout(killProcessTree, opts?.closeoutTimeoutMs);
      const terminateWithEscalation = closeout.terminate;
      const appendOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
        const next = outputBytes + data.byteLength;
        let chunk = data;
        if (opts?.maxBuffer != null && next > opts.maxBuffer) {
          const remaining = Math.max(0, opts.maxBuffer - outputBytes);
          chunk = remaining > 0 ? data.subarray(0, remaining) : Buffer.alloc(0);
          outputBytes = opts.maxBuffer;
          if (!maxBufferExceeded) {
            maxBufferExceeded = true;
            stderr += `\nmaxBuffer exceeded after ${next} bytes`;
            terminateWithEscalation();
          }
        } else {
          outputBytes = next;
        }
        if (chunk.byteLength === 0) return;
        const text = chunk.toString();
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        opts?.onOutput?.(stream, text);
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
        closeout.dispose();
        resolve({
          stdout,
          stderr,
          exitCode: timedOut
            ? EXEC_TIMEOUT_EXIT_CODE
            : aborted
              ? 130
              : maxBufferExceeded
                ? 1
                : exitCode,
        });
      };
      const closeStream = (stream: 'stdout' | 'stderr') => {
        if (stream === 'stdout') stdoutEnded = true;
        else stderrEnded = true;
        tryResolve();
      };
      proc.stdout.on('data', (data: Buffer) => appendOutput('stdout', data));
      proc.stdout.on('end', () => closeStream('stdout'));
      proc.stdout.on('close', () => closeStream('stdout'));
      proc.stdout.on('error', (err) => {
        stderr += `\nstdout stream error: ${err.message}`;
        closeStream('stdout');
      });
      proc.stderr.on('data', (data: Buffer) => appendOutput('stderr', data));
      proc.stderr.on('end', () => closeStream('stderr'));
      proc.stderr.on('close', () => closeStream('stderr'));
      proc.stderr.on('error', (err) => {
        stderr += `\nstderr stream error: ${err.message}`;
        closeStream('stderr');
      });
      proc.on('close', (code) => {
        exitCode = code ?? 1;
        processClosed = true;
        tryResolve();
      });
      proc.on('error', (err) => {
        resolved = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        closeout.dispose();
        resolve({ stdout, stderr: `${stderr}\nspawn error: ${err.message}`, exitCode: 1 });
      });
      if (opts?.timeout != null) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          stderr += `\ncommand timed out after ${opts.timeout}ms`;
          terminateWithEscalation();
        }, opts.timeout);
        timeoutTimer.unref();
      }
      const stopObservingAbort = observeNodeExecAbort(opts?.signal, () => {
        aborted = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        terminateWithEscalation();
      });
      proc.on('close', stopObservingAbort);
    }),
  );
}

// ─── ExecOnSlotOptions ───

export interface ExecOnSlotOptions extends ExecOptions {
  /** Read-only probes may deliver a bundle without selecting it for the slot. */
  selectNodeSupport?: boolean;
}

// ─── execOnSlot ───
// Run a command on the slot's host — locally or via agent-rpc.
// Mirrors bash remote() function.
// Accepts string 3rd arg (cwd) for backward compat, or options object.

export async function execOnSlot(
  slotVars: SlotVars,
  cmd: string,
  optsOrCwd?: string | ExecOnSlotOptions,
): Promise<ExecResult> {
  assertCleanupCurrent();
  const opts: ExecOnSlotOptions =
    typeof optsOrCwd === 'string' ? { cwd: optsOrCwd } : (optsOrCwd ?? {});
  const scoped = currentSlotCommandExecutor();
  if (scoped) {
    // The workspace owner supplies the complete execution contract, including authority
    // rechecks. Never route any nested receipt or input through the ordinary slot broker.
    return trackCleanupCommand(
      scoped(slotVars, cmd, {
        ...opts,
        cwd: opts.cwd ?? slotVars.remoteRepo,
        signal: cleanupSignal(opts.signal),
      }),
    );
  }
  const cwd = opts.cwd ?? slotVars.remoteRepo;
  const signal = cleanupSignal(opts.signal);
  const sources = currentProjectSources();
  if (sources) {
    const execution = sources.execution ?? sources.materialization;
    const { verifyExecutionSources } = await import('../sources/runtime.js');
    await verifyExecutionSources(slotVars.machine, execution);
    const env = sourceExecutionEnvironment(sources);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    cmd = `${Object.entries(env)
      .map(([key, value]) => `export ${key}=${quote(value)};`)
      .join(' ')} ${cmd}`;
  }

  if (isLocal(slotVars.host, slotVars.machine) && !usesNodeLink(slotVars.machine)) {
    return execLocal(cmd, {
      cwd,
      timeout: opts.timeout,
      onOutput: opts.onOutput,
      signal,
      closeoutTimeoutMs: opts.closeoutTimeoutMs,
      maxBuffer: opts.maxBuffer,
    });
  }
  // Every remote command that calls a farm script runs it from the support
  // bundle matching this gateway's config, never from the node's last deploy
  // (ledger F15). Loaded lazily: node-support itself executes through here.
  const timeout = opts.timeout;
  if (commandIncludesRemotePath(cmd, farmPathsForSlot(slotVars).code.node)) {
    const { NodeSupportPendingError, resolveRemoteFarmCommand } =
      await import('../node-support/remote-command.js');
    try {
      cmd = await resolveRemoteFarmCommand(slotVars, cmd, {
        budgetMs: timeout,
        selectSlot: opts.selectNodeSupport,
      });
    } catch (error) {
      // A bounded probe must not wait out a first bundle delivery: it times
      // out like any slow command, and the delivery finishes for the next one.
      if (!(error instanceof NodeSupportPendingError)) throw error;
      return { exitCode: EXEC_TIMEOUT_EXIT_CODE, stdout: '', stderr: error.message };
    }
  }
  if (usesNodeLink(slotVars.machine)) {
    const { execThroughNodeLink } = await import('../fleet/node-link-process.js');
    const shell =
      slotVars.osType === 'darwin' || slotVars.osType === 'macos' ? '/bin/zsh' : '/bin/bash';
    const args = shell === '/bin/zsh' ? ['-f', '-c'] : ['--noprofile', '--norc', '-c'];
    return execThroughNodeLink(slotVars, [shell, ...args, cmd], { ...opts, cwd, signal }, 'login');
  }
  // The timeout belongs to the command after its support bundle is ready,
  // just as execLocal starts its timer at spawn. Resolution has its own
  // bounded delivery wait; a slow local hash must not turn a hook into a 1ms exec.
  assertCleanupCurrent();
  return trackCleanupCommand(
    nodeExec(slotVars.machine, cmd, cwd, {
      timeout,
      onOutput: opts.onOutput,
      maxBuffer: opts.maxBuffer,
      noRetry: opts.noRetry,
      signal,
      closeoutTimeoutMs: opts.closeoutTimeoutMs,
    }),
  );
}

export async function execArgvOnSlot(
  slotVars: SlotVars,
  argv: string[],
  opts: ExecOnSlotOptions = {},
): Promise<ExecResult> {
  assertCleanupCurrent();
  const signal = cleanupSignal(opts.signal);
  const cwd = opts.cwd ?? slotVars.remoteRepo;
  if (isLocal(slotVars.host, slotVars.machine) && !usesNodeLink(slotVars.machine)) {
    return execFileArgv(argv, { ...opts, cwd, signal });
  }
  if (usesNodeLink(slotVars.machine)) {
    const { execThroughNodeLink } = await import('../fleet/node-link-process.js');
    return execThroughNodeLink(
      slotVars,
      argv,
      { ...opts, cwd: opts.cwd ?? slotVars.remoteRepo, signal },
      'service',
    );
  }
  return trackCleanupCommand(
    nodeExecArgv(slotVars.machine, argv, cwd, {
      timeout: opts.timeout,
      onOutput: opts.onOutput,
      maxBuffer: opts.maxBuffer,
      noRetry: opts.noRetry,
      signal,
      closeoutTimeoutMs: opts.closeoutTimeoutMs,
    }),
  );
}
