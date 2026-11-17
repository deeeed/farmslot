// Farmslot task/mark helpers used by the PI extension. Fail closed if TASK.md is missing.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

/** @param {AbortSignal | undefined} signal */
export async function runFarmslotMark(action, env = process.env, signal = undefined) {
  const dir = taskDir(env);
  if (!dir) throw new Error('FARMSLOT_TASK_FILE is not set');
  const mark = path.join(dir, 'mark');
  if (!fs.existsSync(mark)) throw new Error(`mark shim missing at ${mark}`);
  const args = [String(action)];
  if (args[0].toLowerCase() === 'complete') args.push('--mark-last');
  // A mark may run a frozen deterministic check for several minutes. Its
  // lifetime belongs to that check and tool cancellation, not a helper timeout.
  const result = await runFile(mark, args, {
    encoding: 'utf8',
    cwd: dir,
    signal,
    env: { ...process.env, ...env },
  });
  return String(result.stdout);
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
