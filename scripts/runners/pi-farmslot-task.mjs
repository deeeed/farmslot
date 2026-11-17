// Farmslot task/mark helpers used by the PI extension. Fail closed if TASK.md is missing.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export function taskFilePath(env = process.env) {
  return String(env.FARMSLOT_TASK_FILE ?? '').trim();
}

export function taskDir(env = process.env) {
  const file = taskFilePath(env);
  return file ? path.dirname(file) : '';
}

export function readTaskMarkdown(env = process.env) {
  const file = taskFilePath(env);
  if (!file) return null;
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

export function farmslotStatusLine(env = process.env) {
  const parts = [
    'fs',
    env.FARMSLOT_SLOT_ID || 'no-slot',
    (env.FARMSLOT_RUN_ID || '').slice(0, 8),
    env.FARMSLOT_THINKING || '',
    env.FARMSLOT_MODEL || '',
  ].filter(Boolean);
  return parts.join(' ');
}

async function stopMarkTree(child, settled) {
  if (!child.pid) {
    await settled;
    return;
  }
  if (process.platform === 'win32') {
    await runFile('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    await settled;
    return;
  }
  try {
    // This group belongs only to this mark, including its frozen check.
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error; // An already-exited group is stopped.
  }
  await settled;
  const deadline = performance.now() + 1000;
  for (;;) {
    const { stdout } = await runFile('ps', ['-axo', 'pgid=,stat='], { timeout: 1000 });
    const running = stdout.split('\n').some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === child.pid && state && !state.startsWith('Z');
    });
    if (!running) return;
    if (performance.now() >= deadline)
      throw new Error('Mark cancellation could not confirm that its check stopped');
    // Process groups have no exit event for descendants after their parent exits.
    await delay(10);
  }
}

/** @param {AbortSignal | undefined} signal */
export async function runFarmslotMark(action, env = process.env, signal = undefined) {
  const dir = taskDir(env);
  if (!dir) throw new Error('FARMSLOT_TASK_FILE is not set');
  const mark = path.join(dir, 'mark');
  if (!fs.existsSync(mark)) throw new Error(`mark shim missing at ${mark}`);
  const args = [String(action)];
  if (args[0].toLowerCase() === 'complete') args.push('--mark-last');
  signal?.throwIfAborted();
  // A mark may run a frozen check for minutes; cancellation owns its lifetime.
  const ownsGroup = process.platform !== 'win32';
  const child = spawn(mark, args, {
    cwd: dir,
    detached: ownsGroup,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let stdout = '',
    stderr = '';
  let outputError;
  const capture = (stream, text) => {
    if (outputError) return;
    if (Buffer.byteLength((stream === 'stdout' ? stdout : stderr) + text) > 1024 * 1024) {
      outputError = Object.assign(new Error('Mark output exceeded maxBuffer'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
      try {
        if (ownsGroup) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      return;
    }
    if (stream === 'stdout') stdout += text;
    else stderr += text;
  };
  child.stdout.setEncoding('utf8').on('data', (text) => capture('stdout', text));
  child.stderr.setEncoding('utf8').on('data', (text) => capture('stderr', text));
  const settled = once(child, 'close').then(
    ([code, signal]) => {
      if (outputError) return { error: outputError };
      if (code !== 0)
        return {
          error: Object.assign(
            new Error('Command failed: ' + mark + ' ' + args.join(' ') + '\n' + stderr),
            { code, signal, stdout, stderr },
          ),
        };
      return { result: { stdout, stderr } };
    },
    (error) => ({ error }),
  );
  const cancelled = Symbol('cancelled');
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(cancelled);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    const outcome = await (signal ? Promise.race([settled, aborted]) : settled);
    if (outcome === cancelled) {
      await stopMarkTree(child, settled);
      throw Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
    }
    if (outcome.error) throw outcome.error;
    return String(outcome.result.stdout);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function readFarmslotSignal(env = process.env) {
  const dir = taskDir(env);
  if (!dir) throw new Error('FARMSLOT_TASK_FILE is not set');
  const file = path.join(dir, 'SIGNAL.json');
  if (!fs.existsSync(file)) return { present: false, path: file };
  return { present: true, path: file, body: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export async function deliverTaskOnce({ obsDir, sessionId, sendUserMessage, env = process.env }) {
  const task = readTaskMarkdown(env);
  if (!task?.trim()) return false;
  // A slot hosts multiple workers and reviewers. Only this session's delivery
  // of this task may suppress a duplicate session_start notification.
  const key = createHash('sha256')
    .update(JSON.stringify([sessionId, path.resolve(taskFilePath(env))]))
    .digest('hex');
  const marker = path.join(obsDir, 'task-deliveries', key);
  if (fs.existsSync(marker)) return false;
  if (!sendUserMessage) throw new Error('PI task delivery requires sendUserMessage');
  await sendUserMessage(task);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${Date.now()}\n`);
  return true;
}
