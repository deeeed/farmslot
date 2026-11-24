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
// The worst case after a stop: the closeout's SIGKILL (5 s), the forced kill one closeout later
// (10 s), the output drain (12 s), then the post-close group census: one more second, plus a
// last ps of up to 2 s (15 s), after which any group still listed is SIGKILLed. The gateway
// waits 3 x closeout + drain, 17 s, which leaves 2 s for process and transport delays.
export const TASK_RUNTIME_CLOSEOUT_MS = 3 * NODE_EXEC_CLOSEOUT_MS + TASK_OUTPUT_DRAIN_MS;

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

// The task's owned process groups live in a shared Int32Array, groups: slot 0 holds how many
// slots have ever been used, slots 1.. the group ids (0 when free). Drop groups that have
// since emptied, so a later signal cannot reach a reused group id.
const taskPruneGroups = `
const pruneGroups = () => {
  const used = Atomics.load(groups, 0);
  for (let i = 1; i <= used; i++) {
    const pid = Atomics.load(groups, i);
    if (!pid) continue;
    try {
      process.kill(-pid, 0);
    } catch (error) {
      // ESRCH: the group is gone. EPERM: it still exists under another owner, so it stays.
      if (error.code === 'ESRCH') Atomics.compareExchange(groups, i, pid, 0);
      else if (error.code !== 'EPERM') throw error;
    }
  }
};
`;

// The task's watchdog thread. No node is left to escalate, so it does: SIGTERM the task's
// groups, SIGKILL what remains after the node-exec closeout, then the task's own group.
// The main thread asks for it on a dropped channel or a failed send. While the main thread
// is blocked in a synchronous call it sees no disconnect, so the watchdog also stops once
// the task has been reparented: its node is gone.
const taskWatchdog = `
const { parentPort, workerData: { groups, node } } = require('node:worker_threads');
${taskPruneGroups}
const signalGroups = (signal) => {
  const used = Atomics.load(groups, 0);
  for (let i = 1; i <= used; i++) {
    const pid = Atomics.load(groups, i);
    if (!pid) continue;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      // A group that already ended is the expected case; anything else is reported.
      if (error.code !== 'ESRCH') console.error('Task group ' + pid + ' was not stopped: ' + error.message);
    }
  }
};
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(orphaned);
  pruneGroups();
  signalGroups('SIGTERM');
  const deadline = Date.now() + ${NODE_EXEC_CLOSEOUT_MS};
  const settle = () => {
    pruneGroups();
    const used = Atomics.load(groups, 0);
    let tracked = false;
    for (let i = 1; i <= used && !tracked; i++) tracked = Atomics.load(groups, i) !== 0;
    if (tracked && Date.now() < deadline)
      return setTimeout(settle, 100);
    signalGroups('SIGKILL');
    process.kill(0, 'SIGKILL');
  };
  settle();
};
parentPort.on('message', stop);
// The node that started the task is its parent; any other parent means the node is gone,
// including before this thread started.
const orphaned = setInterval(() => {
  if (process.ppid !== node) stop();
}, 500);
if (process.ppid !== node) stop();
`;

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
  postMessage: (message, done) =>
    process.connected ? process.send(message, done) : done?.(new Error('IPC channel closed')),
  // The result send's callback: a failed send was not delivered, so the task stops as if orphaned.
  // A delivered task keeps the channel, so groups it starts later are still reported and a
  // cancel still reaches it, but the channel no longer keeps it alive.
  close: (error) => {
    if (error) return abandon(error);
    delivered = true;
    process.channel?.unref();
  },
};
// The process groups this task owns, in memory its watchdog thread shares.
const groups = new Int32Array(new SharedArrayBuffer(4 * 4096));
${taskPruneGroups}
// A worker thread died with its node; a process must not outlive it. The watchdog stops
// this task's groups, then the task's own group (what it runs synchronously or backgrounds
// untracked, and itself), once the node is gone. It is started before tsx loads, so it
// starts no child.
const { Worker } = require('node:worker_threads');
const watchdog = new Worker(${JSON.stringify(taskWatchdog)}, {
  eval: true,
  workerData: { groups, node: workerData.node },
});
watchdog.unref();
// Set once a stop or an abandon begins: no new subprocess starts after it.
let stopping = false;
// It runs once, whichever of a disconnect, a failed send or a failed write comes first.
let abandoned = false;
const abandon = (cause) => {
  if (abandoned) return;
  abandoned = true;
  // Nothing new may start while the watchdog settles.
  stopping = true;
  if (cause instanceof Error) console.error('Task stopped: ' + cause.message);
  // Nothing else may keep the task alive now; the watchdog ends it.
  watchdog.ref();
  watchdog.postMessage('abandon');
};
process.on('disconnect', () => {
  if (!delivered) abandon();
});
// Node emits 'error' on process only for the IPC channel: a notification sent without a
// callback (task-child, task-stopping) whose write failed because the node is gone. Stop like
// an orphan.
process.on('error', abandon);
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
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
    // The first free slot; a new one only when all used slots hold live groups.
    const used = Atomics.load(groups, 0);
    let slot = 1;
    while (slot <= used && Atomics.load(groups, slot)) slot++;
    if (slot >= groups.length) console.error('Task group ' + pid + ' is not tracked: too many groups');
    else {
      Atomics.store(groups, slot, pid);
      if (slot > used) Atomics.store(groups, 0, slot);
    }
    // Forget the group only once it is empty: a detached grandchild can outlive its leader.
    this.once('close', pruneGroups);
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
  // The full NODE_OPTIONS for the subprocesses provider code starts, put back only now, after
  // tsx registered and the CLI's first modules loaded: a thread started with execArgv re-reads
  // NODE_OPTIONS, so restoring earlier ran the preloads inside this task. A thread started
  // later with execArgv (esbuild's sync worker on a provider's first require of a .ts file, a
  // provider's own Worker) sees them, as it would on the CLI transport. As there, the node's
  // value wins over the checkout's env files, which only fill what is unset.
  if (workerData.nodeOptions !== undefined) process.env.NODE_OPTIONS = workerData.nodeOptions;
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

const PRELOAD_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);
/**
 * NODE_OPTIONS without its module preloads: the flags above, as `--flag value` or
 * `--flag=value`, tokenized as node reads NODE_OPTIONS.
 */
export function withoutPreloads(options: string): string {
  const kept: string[] = [];
  // As node splits it: on spaces only, with backslash escapes only inside double quotes.
  const tokens = options.match(/(?:[^ "]|"(?:[^"\\]|\\.)*")+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // Node reads a flag name without its quotes and with _ for -.
    const flag = (name: string) => name.replace(/"/g, '').replace(/_/g, '-');
    if (PRELOAD_FLAGS.has(flag(token))) i++;
    else if (!PRELOAD_FLAGS.has(flag(token.split('=')[0]!))) kept.push(token);
  }
  return kept.join(' ');
}

/** The ps the post-close census runs; a test points it elsewhere to make the census fail. */
export const censusPs = { path: '/bin/ps' };

/** Caches `read`'s value once it succeeds; a failed read is tried again next time. */
export function cachedOnSuccess<T>(read: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () =>
    (cached ??= read().catch((error: unknown) => {
      cached = undefined;
      throw error;
    }));
}

/** This process's group id, which need not be its pid (yarn farmdev); Node has no getpgid. */
const nodeGroup = cachedOnSuccess(
  () =>
    new Promise<number>((resolve, reject) =>
      execFile(
        '/bin/ps',
        ['-o', 'pgid=', '-p', String(process.pid)],
        { timeout: 2000 },
        (error, output) => {
          const group = Number(output.trim());
          if (error || !Number.isInteger(group) || group < 1)
            reject(error ?? new Error(`Unreadable process group: ${output}`));
          else resolve(group);
        },
      ),
    ),
);

/**
 * The task process's IPC messages; anything else is ignored. Provider code can send too, and
 * the node signals a named group negated: 0 would reach the node's own group, 1 (-1) every
 * process it may signal, its own pid or group id its own group. Those fail closed.
 */
export function parseTaskMessage(raw: unknown, ownGroup: number): TaskMessage | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === 'task-stopping') return { type: 'task-stopping' };
  if (
    (raw.type === 'task-child' ||
      raw.type === 'task-child-exit' ||
      raw.type === 'task-child-reaped') &&
    typeof raw.pid === 'number' &&
    Number.isInteger(raw.pid) &&
    raw.pid > 1 &&
    raw.pid !== process.pid &&
    raw.pid !== ownGroup
  )
    return { type: raw.type, pid: raw.pid };
  if (
    typeof raw.stdout === 'string' &&
    typeof raw.stderr === 'string' &&
    typeof raw.exitCode === 'number' &&
    Number.isInteger(raw.exitCode)
  )
    return { stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exitCode };
  return undefined;
}

/**
 * SIGKILL what a reaped group leader left in its process group. The group id is the leader's
 * pid, and a reaped pid can be reused: a live process holding it is not our leader, so then
 * nothing is signalled. Call it as the leader is reaped, before the id can come round again.
 */
export function killExitedLeaderGroup(
  pgid: number,
  kill: (pid: number, signal: NodeJS.Signals | 0) => unknown = process.kill,
): boolean {
  try {
    kill(pgid, 0);
    return false;
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ESRCH') {
      // EPERM: a process we may not signal holds the pid, so it is not our leader.
      if (isRecord(error) && error.code === 'EPERM') return false;
      throw error;
    }
  }
  try {
    kill(-pgid, 'SIGKILL');
    return true;
  } catch (error) {
    // ESRCH: the group is empty. EPERM: a member we may not signal; the rest were.
    if (!isRecord(error) || (error.code !== 'ESRCH' && error.code !== 'EPERM')) throw error;
    return false;
  }
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
  // Fail closed: without the node's group id a task could name it and have the node signal
  // its own group. A failed read fails this task and is retried on the next one.
  const ownGroup = await nodeGroup();
  if (signal?.aborted) return cancelled();
  const packageRoot = path.resolve(path.dirname(executable), '..');
  env.TSX_TSCONFIG_PATH = path.join(packageRoot, 'tsconfig.json');
  env.TSX_DISABLE_CACHE = '1';
  // A spawned node does not take the node's command-line tsx loader or test flags; only
  // NODE_OPTIONS in env reaches it. The task loads tsx itself from the CLI, so the task's own
  // node starts without preloads (a loader or an --import); other options (a heap ceiling)
  // stay. The task puts the full value back before provider code runs, so the subprocesses it
  // starts get NODE_OPTIONS as they do on the CLI transport.
  const nodeOptions = env.NODE_OPTIONS;
  const taskNodeOptions = nodeOptions && withoutPreloads(nodeOptions);
  if (taskNodeOptions) env.NODE_OPTIONS = taskNodeOptions;
  else delete env.NODE_OPTIONS;
  return new Promise((resolve, reject) => {
    const task = spawn(
      process.execPath,
      [
        '-e',
        taskProcess,
        JSON.stringify({
          action: request.action,
          taskPath: request.taskPath,
          packageRoot,
          node: process.pid,
          nodeOptions,
        }),
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
        // ESRCH: already gone. EPERM: a member we may not signal; the rest were.
        if (!isRecord(error) || (error.code !== 'ESRCH' && error.code !== 'EPERM')) throw error;
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
      try {
        process.kill(-pid, 0);
        if (signal !== 0) process.kill(-pid, signal);
      } catch (error) {
        if (!isRecord(error) || (error.code !== 'ESRCH' && error.code !== 'EPERM')) throw error;
        // A finished or no-longer-owned group (EPERM, on the probe or the signal) must not
        // survive until a later cancellation, when its numeric ID may have been reused.
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
    // When the closeout began: its SIGKILL is due one closeout later.
    let closeoutStarted: number | undefined;
    const startCloseout = () => {
      closeoutStarted ??= Date.now();
      closeout.terminate();
    };
    let delivered = false;
    const stop = (exitCode: number, message: string) => {
      if (stopped) return;
      stopped = true;
      // A result the task already delivered stands; the task and its groups are still stopped.
      if (!delivered) result = { stdout: '', stderr: message, exitCode };
      startCloseout();
      // An exited task has nothing left to signal itself; its tracked groups are closed out.
      if (task.exitCode !== null || task.signalCode !== null) return;
      if (task.connected) task.send({ type: 'task-stop' });
      terminate();
    };
    const abort = () => stop(130, 'Task execution cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(124, `command timed out after ${timeout}ms`), timeout);
    task.on('message', (raw: unknown) => {
      const message = parseTaskMessage(raw, ownGroup);
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
      if (size > 8 * 1024 * 1024) {
        // The bound fails the run even after a delivered result (provider code can send too).
        delivered = false;
        stop(1, `maxBuffer exceeded after ${size} bytes`);
      } else {
        // The first result stands; a later result-shaped message (provider code can send
        // one) only counts against the bound, like output that follows the result.
        if (!delivered) result = message;
        delivered = true;
        outputBytes = size;
      }
    });
    task.on('error', (error: Error) => {
      taskError = error;
      stopped = true;
      startCloseout();
    });
    // 'close' follows exit and the end of the task's stdout and stderr.
    // A detached grandchild that inherited the task's stdout or stderr keeps the pipes open
    // after the task exits; 'close' would wait for it. Give the pipes a bounded drain.
    let drain: ReturnType<typeof setTimeout> | undefined;
    task.on('exit', (exitCode, exitSignal) => {
      // A task that did not end cleanly (crash, OOM, external kill, a forced end) may have
      // left untracked or synchronous subprocesses in its own group. Kill them now, in the
      // tick its leader was reaped: later, the group id (the leader's pid) could belong to
      // someone else. A task that delivered exits 0, and its result may not be read yet here.
      if ((exitCode !== 0 || exitSignal) && task.pid)
        try {
          killExitedLeaderGroup(task.pid);
        } catch (error) {
          // Not thrown out of an event handler, where it would take the node down.
          console.error(`Task group ${task.pid} was not stopped: ${String(error)}`);
        }
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
      // A task that died without a result, or did not end cleanly after it, never stopped its
      // tracked groups: close them out the way a cancellation does. Each group is probed
      // before it is signalled.
      if (!stopped && children.size && (!delivered || code !== 0)) {
        stopped = true;
        startCloseout();
      }
      signal?.removeEventListener('abort', abort);
      const finish = async () => {
        try {
          // A cancellation result confirms both the task process and its async child
          // groups stopped. A forced end kills the task's own group, synchronous subprocesses included.
          // Bounded: a group whose remaining member this process may not signal stays listed.
          // It runs until the closeout's own SIGKILL is due (a crash starts the closeout only
          // at close), or one more second when that is past; each ps can add its 2 s timeout.
          const census = Math.max(
            (closeoutStarted ?? Date.now()) + NODE_EXEC_CLOSEOUT_MS,
            Date.now() + 1000,
          );
          let censusFailure = '';
          while (stopped && children.size && Date.now() < census) {
            let groups: string;
            try {
              groups = await new Promise<string>((done, fail) =>
                execFile(
                  censusPs.path,
                  ['-axo', 'pgid=,stat='],
                  { timeout: 2000 },
                  (error, output) => (error ? fail(error) : done(output)),
                ),
              );
            } catch (error) {
              // A failed census ends it: the groups it could not confirm are named, and the
              // result (a delivered one included) still comes back.
              censusFailure = `Task group census failed: ${error instanceof Error ? error.message : String(error)}\n`;
              break;
            }
            const live = new Set(
              groups.split('\n').flatMap((line) => {
                const [group, state] = line.trim().split(/\s+/);
                return group && state && !state.startsWith('Z') ? [Number(group)] : [];
              }),
            );
            for (const pid of children) if (!live.has(pid)) children.delete(pid);
            // One ps -axo per pass: a 100 ms pause keeps a long wait cheap.
            if (children.size) await new Promise((done) => setTimeout(done, 100));
          }
          const outcome = result ?? {
            stdout: '',
            stderr: taskError?.stack ?? `Task runtime exited without a result (exit ${code}).`,
            exitCode: code || 1,
          };
          // The census ended with groups left (its bound or a failed ps), possibly before the
          // closeout's SIGKILL fired; dispose() below would cancel that, so kill them now.
          if (stopped) for (const pid of children) signalChild(pid, 'SIGKILL');
          // Still tracked after the signals: running in the last census pass (or never confirmed,
          // after a failed ps). One the closeout's SIGKILL caught just before may be dying.
          const left = stopped ? [...children] : [];
          const survivors =
            censusFailure +
            (left.length
              ? `Task groups SIGKILLed after the census (${censusFailure ? 'not confirmed stopped' : 'running at its last pass'}): ${left.join(', ')}\n`
              : '');
          resolve({
            ...outcome,
            stdout: stdout + outcome.stdout,
            stderr: stderr + survivors + outcome.stderr,
          });
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
        // The bound fails the run even after a delivered result, as on the CLI transport.
        delivered = false;
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
