// Farmslot task/mark helpers used by the PI extension. Fail closed if TASK.md is missing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

export function runFarmslotMark(action, env = process.env) {
  const dir = taskDir(env);
  if (!dir) throw new Error('FARMSLOT_TASK_FILE is not set');
  const mark = path.join(dir, 'mark');
  if (!fs.existsSync(mark)) throw new Error(`mark shim missing at ${mark}`);
  const args = [String(action)];
  const result = execFileSync(mark, args, {
    encoding: 'utf8',
    cwd: dir,
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return String(result);
}

export function readFarmslotSignal(env = process.env) {
  const dir = taskDir(env);
  if (!dir) throw new Error('FARMSLOT_TASK_FILE is not set');
  const file = path.join(dir, 'SIGNAL.json');
  if (!fs.existsSync(file)) return { present: false, path: file };
  return { present: true, path: file, body: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export function taskDeliveredMarker(obsDir) {
  return path.join(obsDir, 'task-delivered');
}
