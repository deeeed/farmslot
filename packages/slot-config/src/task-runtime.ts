import { resolveFarmPaths, type FarmPaths } from '@farmslot/protocol/node/farm-paths';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  createNodeExecCloseout,
  isRecord,
  NODE_EXEC_CLOSEOUT_MS,
  type ExecResult,
  type NodeLinkTaskRuntimeInput,
} from '@farmslot/protocol';

export type TaskRuntimeRequest = NodeLinkTaskRuntimeInput;

// Loaded-node task initialization samples reached 265s retaining CLI/provider
// inputs. Keep the existing ten-minute budget and two-minute verification cap.
export const TASK_RUNTIME_TIMEOUT_MS = { init: 10 * 60_000, verify: 120_000 } as const;
export const TASK_RUNTIME_CLOSEOUT_MS = 2 * NODE_EXEC_CLOSEOUT_MS;

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

// Providers change process.env while loading. A worker keeps those changes and
// the CLI's module-level config private without starting a CLI process. Resolve
// every import from the selected installation, just as its bin/farmslot.mjs does.
const taskWorker = `
const { parentPort, workerData } = require('node:worker_threads');
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
  loadCheckoutEnv(repoRoot);
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
    parentPort.postMessage({ stdout: JSON.stringify(result, null, 2) + '\\n', stderr: '', exitCode: 0 });
    parentPort.close();
  } catch (error) {
    const exitCode = error instanceof Error && typeof error.exitCode === 'number' ? error.exitCode : 1;
    result = errorEnvelope(command, error);
    if (workerData.action === 'init') result.exitCode = exitCode;
    parentPort.postMessage({ stdout: JSON.stringify(result, null, 2) + '\\n', stderr: '', exitCode });
    parentPort.close();
  }
})().catch((error) => { throw error; });
`;

/**
 * Same installation, pool, pack and machine environment as the CLI transport.
 * Provider initializers use their explicit checkout context and absolute paths;
 * daemon threads cannot provide a process-wide cwd or process.chdir per task.
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
  env.FARMSLOT_POOL_DIR = selected.pool;
  const support = request.supportDir.startsWith('~/')
    ? path.join(env.HOME || os.homedir(), request.supportDir.slice(2))
    : request.supportDir;
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
    const worker = new Worker(taskWorker, {
      eval: true,
      env,
      // Do not inherit the gateway's tsx loader or test flags into the CLI's
      // independent loader. Its own tsconfig selects its installed libraries.
      execArgv: [],
      workerData: { action: request.action, taskPath: request.taskPath, packageRoot },
      stdout: true,
      stderr: true,
    });
    const timeout = TASK_RUNTIME_TIMEOUT_MS[request.action];
    let result: ExecResult | undefined;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let stopped = false;
    let workerError: Error | undefined;
    const children = new Set<number>();
    const childRoots = new Set<number>();
    let stoppingAcknowledged = false;
    let forcedThreadTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (stopped && stoppingAcknowledged && !childRoots.size)
        void worker.terminate().catch(reject);
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
        if (!stoppingAcknowledged) void worker.terminate().catch(reject);
        else
          forcedThreadTimer = setTimeout(() => {
            void worker.terminate().catch(reject);
          }, NODE_EXEC_CLOSEOUT_MS);
      }
    });
    const stop = (exitCode: number, message: string) => {
      if (stopped) return;
      stopped = true;
      result = { stdout: '', stderr: message, exitCode };
      closeout.terminate();
      worker.postMessage({ type: 'task-stop' });
      terminate();
    };
    const abort = () => stop(130, 'Task execution cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(124, `command timed out after ${timeout}ms`), timeout);
    worker.on(
      'message',
      (
        message:
          | ExecResult
          | { type: 'task-child' | 'task-child-exit' | 'task-child-reaped'; pid: number }
          | { type: 'task-stopping' },
      ) => {
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
        else result = message;
      },
    );
    worker.on('error', (error: Error) => {
      workerError = error;
      stopped = true;
      closeout.terminate();
    });
    worker.on('exit', (code) => {
      clearTimeout(timer);
      clearTimeout(forcedThreadTimer);
      signal?.removeEventListener('abort', abort);
      const finish = async () => {
        try {
          // A cancellation result confirms both the thread and its async child
          // groups stopped. Synchronous library probes finish before thread exit.
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
            stderr: workerError?.stack ?? `Task runtime exited without a result (exit ${code}).`,
            exitCode: code || 1,
          };
          resolve({ ...outcome, stdout: stdout + outcome.stdout, stderr: stderr + outcome.stderr });
        } finally {
          clearTimeout(forcedThreadTimer);
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
    worker.stdout.on('data', (data: Buffer) => append('stdout', data));
    worker.stderr.on('data', (data: Buffer) => append('stderr', data));
  });
}
