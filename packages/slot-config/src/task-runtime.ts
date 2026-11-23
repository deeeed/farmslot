import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createNodeExecCloseout,
  type ExecResult,
  isRecord,
  NODE_EXEC_CLOSEOUT_MS,
  type NodeLinkTaskRuntimeInput,
} from '@farmslot/protocol';
import { type FarmPaths, resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';

export type TaskRuntimeRequest = NodeLinkTaskRuntimeInput;

// Loaded-node task initialization samples reached 265s retaining CLI/provider
// inputs. Keep the existing ten-minute budget and two-minute verification cap.
export const TASK_RUNTIME_TIMEOUT_MS = { init: 10 * 60_000, verify: 120_000 } as const;
/**
 * How long a finished task's stdout and stderr may stay open, held by a descendant. Output a
 * descendant writes after that is dropped; the result itself arrives over IPC and is never cut.
 */
export const TASK_OUTPUT_DRAIN_MS = 2000;
export const TASK_RUNTIME_CLOSEOUT_MS = 2 * NODE_EXEC_CLOSEOUT_MS + TASK_OUTPUT_DRAIN_MS;

export function parseTaskRuntimeRequest(value: unknown): TaskRuntimeRequest {
  if (
    !isRecord(value) ||
    (value.action !== 'init' && value.action !== 'verify') ||
    typeof value.taskPath !== 'string' ||
    !path.isAbsolute(value.taskPath) ||
    typeof value.supportDir !== 'string' ||
    !(path.isAbsolute(value.supportDir) || value.supportDir.startsWith('~/')) ||
    !isRecord(value.env) ||
    Object.values(value.env).some((entry) => typeof entry !== 'string')
  )
    throw new Error('Invalid task runtime request.');
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string')
      throw new Error('Invalid task runtime environment.');
    env[key] = entry;
  }
  return { action: value.action, taskPath: value.taskPath, supportDir: value.supportDir, env };
}

// Providers change process.env while loading. A child process keeps those changes
// and the CLI's module-level config private. It is a process, not a worker thread:
// tsx's ESM loader thread owns an esbuild service child, and a thread that exits
// leaves that child unreaped, one zombie of the node per task. Resolve every import
// from the selected installation, just as its bin/farmslot.mjs does.
const taskProcess = `
const workerData = JSON.parse(process.argv[1]);
// IPC stands in for a worker port. A message after the parent closed the channel is dropped.
let delivered = false;
const parentPort = {
  on: (event, listener) => process.on(event, listener),
  postMessage: (message, done) => (process.connected ? process.send(message, done) : done?.()),
  // The result send's callback: a failed send was not delivered, so the task stops as if orphaned.
  close: (error) => {
    if (error) return abandon(error);
    delivered = true;
    if (process.connected) process.disconnect();
  },
};
// A worker thread died with its node; a process must not outlive it. If the channel drops
// before the result went out, the node or gateway is gone: stop this task's groups and exit.
const ownedGroups = new Set();
// Drop groups that have since emptied, so a later signal cannot reach a reused group id.
const pruneGroups = () => {
  for (const pid of ownedGroups) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      // ESRCH: the group is gone. EPERM: it still exists under another owner, so it stays.
      if (error.code === 'ESRCH') ownedGroups.delete(pid);
      else if (error.code !== 'EPERM') throw error;
    }
  }
};
const signalGroups = (signal) => {
  for (const pid of ownedGroups) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      // A group that already ended is the expected case; anything else is reported.
      if (error.code !== 'ESRCH') console.error('Task group ' + pid + ' was not stopped: ' + error.message);
    }
  }
};
// No node is left to escalate, so the task does it: SIGTERM, then SIGKILL what remains.
const abandon = (cause) => {
  if (cause instanceof Error) console.error('Task stopped: ' + cause.message);
  pruneGroups();
  signalGroups('SIGTERM');
  const deadline = Date.now() + ${NODE_EXEC_CLOSEOUT_MS};
  const settle = () => {
    pruneGroups();
    if (ownedGroups.size && Date.now() < deadline) return setTimeout(settle, 100);
    signalGroups('SIGKILL');
    process.exit(1);
  };
  settle();
};
process.on('disconnect', () => {
  if (!delivered) abandon();
});
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
let stopping = false;
parentPort.on('message', (message) => {
  if (message.type === 'task-stop') {
    stopping = true;
    parentPort.postMessage({ type: 'task-stopping' });
  }
});
// Each async subprocess gets an owned process group, as the old CLI execution
// did. This also covers exec/execFile/fork, which call ChildProcess.spawn.
const { ChildProcess } = require('node:child_process');
const spawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function(options) {
  if (stopping) throw new Error('Task execution cancelled.');
  const result = spawn.call(this, { ...options, detached: true });
  if (this.pid) {
    const pid = this.pid;
    pruneGroups();
    ownedGroups.add(pid);
    // Forget the group only once it is empty: a detached grandchild can outlive its leader.
    this.once('close', () => {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        // ESRCH: empty, forget it. EPERM: still there under another owner, keep it.
        if (error.code === 'ESRCH') ownedGroups.delete(pid);
        else if (error.code !== 'EPERM') throw error;
      }
    });
    parentPort.postMessage({ type: 'task-child', pid });
    this.once('exit', () => parentPort.postMessage({ type: 'task-child-reaped', pid }));
    this.once('close', () => parentPort.postMessage({ type: 'task-child-exit', pid }));
  }
  return result;
};
(async () => {
  const root = workerData.packageRoot;
  const fromCli = createRequire(path.join(root, 'package.json'));
  fromCli('tsx/cjs');
  const { register } = await import(pathToFileURL(fromCli.resolve('tsx/esm/api')).href);
  register({ tsconfig: path.join(root, 'tsconfig.json') });
  const { loadCheckoutEnv } = await import(pathToFileURL(path.join(root, 'src/onboarding/env-file.ts')).href);
  const { bootstrapFarmslotHome, repoRoot } = await import(pathToFileURL(path.join(root, 'src/onboarding/workspace.ts')).href);
  loadCheckoutEnv(repoRoot());
  bootstrapFarmslotHome();
  const { okEnvelope, errorEnvelope } = await import(pathToFileURL(path.join(root, 'src/envelope.ts')).href);
  const command = workerData.action === 'init' ? 'internal.task-init' : 'task.verify';
  let result;
  try {
    if (workerData.action === 'init') {
      const { runHostedTaskInit } = await import(pathToFileURL(path.join(root, 'src/commands/hosted-task-init.ts')).href);
      result = okEnvelope(command, await runHostedTaskInit(workerData.taskPath));
    } else {
      const { verifySelectedTask } = await import(pathToFileURL(fromCli.resolve('@farmslot/recipe-cli/harness')).href);
      result = verifySelectedTask(workerData.taskPath);
    }
    parentPort.postMessage({ stdout: JSON.stringify(result, null, 2) + '\\n', stderr: '', exitCode: 0 }, parentPort.close);
  } catch (error) {
    const exitCode = error instanceof Error && typeof error.exitCode === 'number' ? error.exitCode : 1;
    result = errorEnvelope(command, error);
    if (workerData.action === 'init') result.exitCode = exitCode;
    parentPort.postMessage({ stdout: JSON.stringify(result, null, 2) + '\\n', stderr: '', exitCode }, parentPort.close);
  }
})().catch((error) => { throw error; });
`;

type TaskMessage =
  | ExecResult
  | { type: 'task-child' | 'task-child-exit' | 'task-child-reaped'; pid: number }
  | { type: 'task-stopping' };

/** The task process's IPC messages; anything else is ignored. */
function parseTaskMessage(raw: unknown): TaskMessage | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === 'task-stopping') return { type: 'task-stopping' };
  if (
    (raw.type === 'task-child' ||
      raw.type === 'task-child-exit' ||
      raw.type === 'task-child-reaped') &&
    typeof raw.pid === 'number'
  )
    return { type: raw.type, pid: raw.pid };
  if (
    typeof raw.stdout === 'string' &&
    typeof raw.stderr === 'string' &&
    typeof raw.exitCode === 'number'
  )
    return { stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exitCode };
  return undefined;
}

/**
 * Same installation, pool, pack and machine environment as the CLI transport.
 * Provider initializers use their explicit checkout context and absolute paths;
 * the task process keeps its node's cwd.
 */
export async function runTaskRuntime(
  request: TaskRuntimeRequest,
  farmDir: string,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  paths?: FarmPaths,
): Promise<ExecResult> {
  const cancelled = (): ExecResult => ({
    stdout: '',
    stderr: 'Command cancelled before execution.',
    exitCode: 130,
  });
  if (signal?.aborted) return cancelled();
  const env = { ...inheritedEnv };
  delete env.FORCE_COLOR;
  Object.assign(env, request.env);
  delete env.FARMSLOT_ROOT;
  const selected =
    paths ??
    resolveFarmPaths({
      role: 'node',
      env,
      checkoutRoot: farmDir,
      userHome: env.HOME || os.homedir(),
    });
  if (selected.layout === 2) env.FARMSLOT_HOME = selected.home;
  env.FARMSLOT_POOL_DIR = selected.pool;
  const support = request.supportDir.startsWith('~/')
    ? path.join(env.HOME || os.homedir(), request.supportDir.slice(2))
    : request.supportDir;
  if (request.action === 'init') env.FARMSLOT_TASK_SUPPORT_DIR = support;
  env.FARMSLOT_PROJECTS_DIR =
    selected.layout === 2
      ? selected.projects
      : resolveFarmPaths({ role: 'node', env, checkoutRoot: support }).projects;
  env.FARMSLOT_CLI ||= path.join(selected.code.bin, 'farmslot');
  const executable = await realpath(env.FARMSLOT_CLI);
  if (signal?.aborted) return cancelled();
  const packageRoot = path.resolve(path.dirname(executable), '..');
  env.TSX_TSCONFIG_PATH = path.join(packageRoot, 'tsconfig.json');
  env.TSX_DISABLE_CACHE = '1';
  return new Promise((resolve, reject) => {
    // A spawned node does not take the node's command-line tsx loader or test flags (only
    // NODE_OPTIONS in env would reach it): the CLI's own tsconfig selects its libraries.
    const task = spawn(
      process.execPath,
      [
        '-e',
        taskProcess,
        JSON.stringify({ action: request.action, taskPath: request.taskPath, packageRoot }),
      ],
      // Its own process group: a forced end reaches what it runs synchronously or backgrounds
      // untracked, and stopping the node job does not kill it before its own cleanup runs.
      { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true },
    );
    const killTask = () => {
      if (task.exitCode !== null || task.signalCode !== null || !task.pid) return;
      try {
        process.kill(-task.pid, 'SIGKILL');
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ESRCH') throw error;
      }
    };
    const timeout = TASK_RUNTIME_TIMEOUT_MS[request.action];
    let result: ExecResult | undefined;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let stopped = false;
    let taskError: Error | undefined;
    const children = new Set<number>();
    const childRoots = new Set<number>();
    let stoppingAcknowledged = false;
    let forcedKillTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (stopped && stoppingAcknowledged && !childRoots.size) killTask();
    };
    const signalChild = (pid: number, signal: NodeJS.Signals | 0) => {
      let probing = true;
      try {
        process.kill(-pid, 0);
        probing = false;
        if (signal !== 0) process.kill(-pid, signal);
      } catch (error) {
        if (!isRecord(error) || (error.code !== 'ESRCH' && !(probing && error.code === 'EPERM')))
          throw error;
        // A finished or no-longer-owned group must not survive until a later
        // cancellation, when its numeric ID may have been reused.
        children.delete(pid);
      }
    };
    const closeout = createNodeExecCloseout((signal) => {
      for (const pid of children) signalChild(pid, signal);
      if (signal === 'SIGKILL') {
        if (!stoppingAcknowledged) killTask();
        else
          forcedKillTimer = setTimeout(() => {
            killTask();
          }, NODE_EXEC_CLOSEOUT_MS);
      }
    });
    let delivered = false;
    const stop = (exitCode: number, message: string) => {
      // A result the task already delivered stands, even while a held pipe delays 'close'.
      if (stopped || delivered || task.exitCode !== null || task.signalCode !== null) return;
      stopped = true;
      result = { stdout: '', stderr: message, exitCode };
      closeout.terminate();
      if (task.connected) task.send({ type: 'task-stop' });
      terminate();
    };
    const abort = () => stop(130, 'Task execution cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(124, `command timed out after ${timeout}ms`), timeout);
    task.on('message', (raw: unknown) => {
      const message = parseTaskMessage(raw);
      if (!message) return;
      if ('type' in message) {
        if (message.type === 'task-stopping') stoppingAcknowledged = true;
        else if (message.type === 'task-child-reaped') signalChild(message.pid, 0);
        else if (message.type === 'task-child-exit') {
          childRoots.delete(message.pid);
          signalChild(message.pid, 0);
        } else {
          children.add(message.pid);
          childRoots.add(message.pid);
          if (stopped) signalChild(message.pid, 'SIGTERM');
        }
        terminate();
        return;
      }
      if (stopped) return;
      const size =
        outputBytes + Buffer.byteLength(message.stdout) + Buffer.byteLength(message.stderr);
      if (size > 8 * 1024 * 1024) stop(1, `maxBuffer exceeded after ${size} bytes`);
      else {
        result = message;
        delivered = true;
      }
    });
    task.on('error', (error: Error) => {
      taskError = error;
      stopped = true;
      closeout.terminate();
    });
    // 'close' follows exit and the end of the task's stdout and stderr.
    // A detached grandchild that inherited the task's stdout or stderr keeps the pipes open
    // after the task exits; 'close' would wait for it. Give the pipes a bounded drain.
    let drain: ReturnType<typeof setTimeout> | undefined;
    task.on('exit', () => {
      drain = setTimeout(() => {
        task.stdout?.destroy();
        task.stderr?.destroy();
      }, TASK_OUTPUT_DRAIN_MS);
      drain.unref();
    });
    task.on('close', (exitCode, exitSignal) => {
      const code = exitCode ?? (exitSignal ? 1 : 0);
      clearTimeout(timer);
      clearTimeout(forcedKillTimer);
      clearTimeout(drain);
      // A task that died without a result (crash, OOM, external kill) never stopped its
      // tracked groups: close them out the way a cancellation does, and kill what it left in
      // its own group (untracked or synchronous subprocesses).
      if (!delivered && !stopped) {
        try {
          if (task.pid) process.kill(-task.pid, 'SIGKILL');
        } catch (error) {
          if (!isRecord(error) || error.code !== 'ESRCH') throw error;
        }
        if (children.size) {
          stopped = true;
          closeout.terminate();
        }
      }
      signal?.removeEventListener('abort', abort);
      const finish = async () => {
        try {
          // A cancellation result confirms both the task process and its async child
          // groups stopped. A forced end kills the task's own group, synchronous subprocesses included.
          while (stopped && children.size) {
            const groups = await new Promise<string>((done, fail) =>
              execFile('/bin/ps', ['-axo', 'pgid=,stat='], { timeout: 2000 }, (error, output) =>
                error ? fail(error) : done(output),
              ),
            );
            const live = new Set(
              groups.split('\n').flatMap((line) => {
                const [group, state] = line.trim().split(/\s+/);
                return group && state && !state.startsWith('Z') ? [Number(group)] : [];
              }),
            );
            for (const pid of children) if (!live.has(pid)) children.delete(pid);
            if (children.size) await new Promise((done) => setTimeout(done, 10));
          }
          const outcome = result ?? {
            stdout: '',
            stderr: taskError?.stack ?? `Task runtime exited without a result (exit ${code}).`,
            exitCode: code || 1,
          };
          resolve({ ...outcome, stdout: stdout + outcome.stdout, stderr: stderr + outcome.stderr });
        } finally {
          clearTimeout(forcedKillTimer);
          closeout.dispose();
        }
      };
      void finish().catch(reject);
    });
    // Keep the CLI's diagnostic output and the same 8 MiB execution bound.
    const append = (stream: 'stdout' | 'stderr', data: Buffer) => {
      if (stopped) return;
      outputBytes += data.length;
      if (outputBytes > 8 * 1024 * 1024) {
        stop(1, `maxBuffer exceeded after ${outputBytes} bytes`);
        return;
      }
      if (stream === 'stdout') stdout += data.toString();
      else stderr += data.toString();
    };
    task.stdout?.on('data', (data: Buffer) => append('stdout', data));
    task.stderr?.on('data', (data: Buffer) => append('stderr', data));
  });
}
