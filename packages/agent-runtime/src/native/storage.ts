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

import type { ProcessIdentity } from './process-tree.js';

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
    // Permission denial still proves a process/group exists. It is never
    // evidence of absence and must not make every read of its owner fail.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
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

export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

type ProcessMetadataField = 'lstart' | 'command' | 'pgid';
interface ProcessMetadataObservation {
  observedAt: number;
  fields: Partial<Record<ProcessMetadataField, string>>;
}
/** Passive observations only. Control and cleanup checks omit this cache. */
export type ProcessMetadataCache = Map<number, ProcessMetadataObservation>;

function processMetadata(
  pid: number,
  field: ProcessMetadataField,
  timeout: number,
  observations?: ProcessMetadataCache,
): string {
  const observedAt = Date.now();
  const previous = observations?.get(pid);
  const cached = previous && observedAt - previous.observedAt < 60_000 ? previous : undefined;
  if (cached?.fields[field] !== undefined) return cached.fields[field];
  const value = execFileSync('ps', ['-p', String(pid), '-o', `${field}=`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  }).trim();
  observations?.set(pid, {
    observedAt: cached?.observedAt ?? observedAt,
    fields: { ...cached?.fields, [field]: value },
  });
  return value;
}

export function processGroupId(pid: number, observations?: ProcessMetadataCache): number {
  return Number(processMetadata(pid, 'pgid', 5000, observations));
}

/** A supervisor or host as recorded on disk. Records written before start identities have only the PID. */
export interface RecordedProcess {
  pid: number;
  identity?: string;
}
/** The process's start time: the identity the census records, which a reused PID never matches. */
export function processStartIdentity(pid: number): string {
  return processMetadata(pid, 'lstart', 5000);
}
/** A recorded process is live only while its PID still has the recorded start. */
export function recordedProcessAlive(record: RecordedProcess): boolean {
  return record.identity ? processIdentityAlive(record.pid, record.identity) : alive(record.pid);
}
/** Fresh by default: PID reuse never counts as the old descendant surviving. */
export function processIdentityAlive(
  pid: number,
  identity: string,
  observations?: ProcessMetadataCache,
): boolean {
  if (!alive(pid)) {
    observations?.delete(pid);
    return false;
  }
  try {
    return processMetadata(pid, 'lstart', 5000, observations) === identity.trim();
  } catch (error) {
    if (!alive(pid)) return false;
    // A living but unreadable PID is uncertain, never proof of cleanup.
    if ((error as { status?: number }).status === 1) return true;
    throw error;
  }
}

/** A different leader birth proves numeric group reuse; orphaned or unreadable groups block. */
export function recordedProcessGroupAlive(
  pid: number,
  identity?: string,
  snapshot?: ReadonlyMap<number, ProcessIdentity>,
  observations?: ProcessMetadataCache,
): boolean {
  if (snapshot) {
    if (![...snapshot.values()].some((entry) => entry.group === pid)) return false;
    const leader = snapshot.get(pid);
    return !identity || !leader || leader.identity.trim() === identity.trim();
  }
  if (!processGroupAlive(pid)) return false;
  // PID allocation reserves live group IDs. A reused live leader cannot own the old group.
  if (identity && alive(pid) && !processIdentityAlive(pid, identity, observations) && alive(pid))
    return false;
  return true;
}

/** Structured process argv evidence, never runner stdout or a terminal rendering. */
export function matchesProcess(
  pid: number,
  identity: string,
  observations?: ProcessMetadataCache,
): boolean {
  if (!alive(pid)) {
    observations?.delete(pid);
    return false;
  }
  try {
    const argv = processMetadata(pid, 'command', 1000, observations);
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
