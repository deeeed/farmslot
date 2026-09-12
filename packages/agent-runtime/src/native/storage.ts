import { execFileSync } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** Drop only an incomplete final write before any recovery reader or writer proceeds. */
export function readJournal(path: string): string[] {
  const fd = openSync(path, 'r+');
  try {
    const bytes = readFileSync(fd);
    const end = bytes.lastIndexOf(10) + 1;
    if (end < bytes.length) {
      ftruncateSync(fd, end);
      fsyncSync(fd);
    }
    return bytes.subarray(0, end).toString().split('\n').filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error(`Native state directory must be owned by this OS user with mode 0700: ${path}`);
}
export function durableWrite(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export function readJson<T>(path: string): T {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error('Native state file must be private and owned by this OS user');
  // Only trusted, private runtime files use this decoder. IPC validates its input separately.
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // A group that already exited is the requested stopped outcome.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Structured process argv evidence, never runner stdout or a terminal rendering. */
export function matchesProcess(pid: number, identity: string): boolean {
  if (!alive(pid)) return false;
  try {
    const argv = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1_000,
    });
    return argv.split(/\s+/).includes(identity);
  } catch (error) {
    // The process may exit between the liveness and argv reads. No signal is needed then.
    if (!alive(pid)) return false;
    throw error;
  }
}

export function appendDurable(path: string, value: unknown): void {
  const fd = openSync(path, 'a', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
