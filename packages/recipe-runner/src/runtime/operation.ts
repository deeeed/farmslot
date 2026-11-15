// Invocation records keep concurrent command observations independent of locks.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type TaskOperation, validateOperationRecord } from '@farmslot/protocol';

/**
 * The start time `ps` reports for `pid`; undefined when no such process exists.
 * null when this process may not run `ps` at all: macOS refuses to exec the
 * setuid /bin/ps inside any sandbox (EPERM). The identity is then unknown, not absent.
 */
export function processIdentity(pid: number): string | null | undefined {
  if (pid === process.pid && ownIdentity) return ownIdentity.value;
  const value = readProcessIdentity(pid);
  // This process's own start time cannot change while it runs: read it once.
  if (pid === process.pid) ownIdentity = { value };
  return value;
}

let ownIdentity: { value: string | null | undefined } | undefined;

function readProcessIdentity(pid: number): string | null | undefined {
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return value || undefined;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return undefined;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return null;
    throw error;
  }
}

// One `ps` listing answers a burst of liveness checks: callers check many records at
// once, and one `ps` per record cost seconds. Only a match is trusted from the listing;
// a miss or a different start time is confirmed with a fresh `ps` before it counts.
const IDENTITY_SNAPSHOT_MS = 2_000;
let identitySnapshot: { at: number; byPid: Map<number, string> | null } | undefined;

function snapshotIdentity(pid: number): string | null | undefined {
  if (!identitySnapshot || Date.now() - identitySnapshot.at >= IDENTITY_SNAPSHOT_MS) {
    identitySnapshot = readIdentitySnapshot();
  }
  return identitySnapshot.byPid === null ? null : identitySnapshot.byPid.get(pid);
}

function readIdentitySnapshot(): { at: number; byPid: Map<number, string> | null } {
  try {
    const output = execFileSync('ps', ['-Ao', 'pid=,lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const byPid = new Map<number, string>();
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (match) byPid.set(Number(match[1]), match[2]);
    }
    return { at: Date.now(), byPid };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return { at: Date.now(), byPid: null };
    throw error;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether `pid` is still the process that recorded `startedAt`. When either
 * identity is unknown, only liveness can be checked, so a live pid counts as the owner.
 */
export function processStillRunning(pid: number, startedAt: string | undefined): boolean {
  // A dead pid needs no `ps`: checkouts keep hundreds of stale running records,
  // and spawning `ps` for each one made every `status` call take minutes.
  if (!processAlive(pid)) return false;
  if (startedAt === undefined) return true;
  const listed = snapshotIdentity(pid);
  if (listed === null || listed === startedAt) return true;
  const identity = processIdentity(pid);
  return identity === null || identity === startedAt;
}

/**
 * One operation's log stops here. Teeing a command's own output into the log
 * means a long verbose run writes everything it prints, where it used to write
 * nothing, and a farm node can be down to its last couple of GiB. The marker
 * reports what was dropped, so a reader is never left guessing whether the log
 * simply ended.
 */
const MAX_OPERATION_LOG_BYTES = 2 * 1024 * 1024;

export class OperationRecord {
  readonly file: string;
  readonly value: TaskOperation;
  private readonly files: string[];
  private readonly timer: ReturnType<typeof setInterval>;
  private lastFlush = 0;
  private disabled = false;
  private logBytes = 0;
  private droppedBytes = 0;
  private readonly notification?: string;

  constructor(
    directory: string,
    command: string,
    target: string,
    options: { parentId?: string; mirrorDirectory?: string } = {},
  ) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.notification = options.mirrorDirectory
      ? path.join(path.dirname(options.mirrorDirectory), 'operations-updated.json')
      : undefined;
    this.file = path.join(directory, `${id}.json`);
    this.files = [
      this.file,
      ...(options.mirrorDirectory ? [path.join(options.mirrorDirectory, `${id}.json`)] : []),
    ];
    const logPath = path.join(options.mirrorDirectory ?? directory, `${id}.log`);
    ensureRuntimeDirectory(path.dirname(logPath));
    fs.writeFileSync(logPath, '', { flag: 'wx', mode: 0o600 });
    fs.chmodSync(logPath, 0o600);
    const identity = processIdentity(process.pid);
    if (identity === undefined) throw new Error('Cannot identify the operation owner process');
    this.value = {
      schemaVersion: 1,
      id,
      ...(options.parentId ? { parentId: options.parentId } : {}),
      command,
      target,
      pid: process.pid,
      ...(identity ? { processStartedAt: identity } : {}),
      startedAt: now,
      updatedAt: now,
      status: 'running',
      logPath,
    };
    for (const file of this.files) ensureRuntimeDirectory(path.dirname(file));
    this.flush();
    this.timer = setInterval(() => this.observe(() => this.flush()), 5000);
    this.timer.unref();
  }

  stage(stage: string): void {
    if (stage === this.value.stage) return;
    this.value.stage = stage;
    this.value.stageStartedAt = new Date().toISOString();
    this.observe(() => this.flush());
  }

  output(chunk: string | Uint8Array): void {
    if (chunk.length === 0) return;
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    const room = MAX_OPERATION_LOG_BYTES - this.logBytes;
    if (room <= 0) {
      this.droppedBytes += bytes;
      this.value.lastOutputAt = new Date().toISOString();
      return;
    }
    // A write that crosses the cap keeps the part that fits. Dropping it whole
    // would lose an entire leaf: `spawnScript` hands a command's complete
    // output over in one call, up to its 64 MiB buffer, so a failed step's
    // stderr arrives as a single write and whole-chunk dropping would store
    // none of it. The kept part ends on a line break when there is one in
    // range, so the log does not stop mid-line.
    if (bytes > room) {
      const buffer = Buffer.from(chunk as Uint8Array | string);
      const lastBreak = buffer.subarray(0, room).lastIndexOf(0x0a);
      // Whole lines only. A byte-prefix would leave a partial line in the log
      // and could cut a multi-byte character in half, writing bytes that are
      // not valid UTF-8. When the room left cannot hold a complete line, the
      // write is withheld entirely and counted as dropped — that costs at most
      // the tail of one line, where keeping the prefix would corrupt the file.
      if (lastBreak < 0) {
        this.droppedBytes += bytes;
        this.value.lastOutputAt = new Date().toISOString();
        return;
      }
      const kept = buffer.subarray(0, lastBreak + 1);
      this.observe(() => {
        fs.appendFileSync(this.value.logPath, kept);
        this.logBytes += kept.length;
        this.droppedBytes += bytes - kept.length;
        this.value.lastOutputAt = new Date().toISOString();
        this.flush();
      });
      return;
    }
    this.observe(() => {
      fs.appendFileSync(this.value.logPath, chunk);
      this.logBytes += bytes;
      this.value.lastOutputAt = new Date().toISOString();
      if (Date.now() - this.lastFlush >= 1000) this.flush();
    });
  }

  finish(exitCode: number): void {
    clearInterval(this.timer);
    // One line, once, after the last output: the total is only known now.
    // Order matters: end the payload at a line break first, so the count the
    // marker reports is the count a reader can verify.
    if (this.droppedBytes > 0) this.observe(() => this.endAtLastLine());
    if (this.droppedBytes > 0)
      this.observe(() =>
        fs.appendFileSync(
          this.value.logPath,
          `\n[log truncated: kept ${this.logBytes} bytes of a ${MAX_OPERATION_LOG_BYTES} byte limit; ${this.droppedBytes} further bytes dropped]\n`,
        ),
      );
    this.value.exitCode = exitCode;
    this.value.status = exitCode === 0 ? 'pass' : 'fail';
    this.value.finishedAt = new Date().toISOString();
    this.observe(() => this.flush());
  }

  /**
   * End a truncated log at its last line break.
   *
   * Adapters forward raw pipe buffers, so a write that fits can end in the
   * middle of a multi-byte character, with the bytes completing it in the next
   * write. While everything is appended that resolves itself; once a write is
   * withheld at the cap it never does, and the log would end in bytes that are
   * not valid UTF-8. Cutting back to the last newline covers that and any
   * partial last line in one rule, with no need to reason about byte classes.
   *
   * A log with no line break at all is left alone: it is one unterminated line,
   * and discarding all of it to tidy a few bytes would lose more than it fixes.
   */
  private endAtLastLine(): void {
    if (this.logBytes === 0) return;
    const window = 64 * 1024;
    const handle = fs.openSync(this.value.logPath, 'r');
    let lastBreak = -1;
    try {
      for (let end = this.logBytes; end > 0 && lastBreak < 0; end -= window) {
        const size = Math.min(window, end);
        const buffer = Buffer.alloc(size);
        fs.readSync(handle, buffer, 0, size, end - size);
        const index = buffer.lastIndexOf(0x0a);
        if (index >= 0) lastBreak = end - size + index;
      }
    } finally {
      fs.closeSync(handle);
    }
    if (lastBreak < 0) return;
    const keep = lastBreak + 1;
    if (keep === this.logBytes) return;
    fs.truncateSync(this.value.logPath, keep);
    this.droppedBytes += this.logBytes - keep;
    this.logBytes = keep;
  }

  private observe(write: () => void): void {
    if (this.disabled) return;
    try {
      write();
    } catch (error) {
      // Observation is optional. Stop it explicitly without terminating the
      // command or its children from an event callback. Old records go stale.
      this.disabled = true;
      clearInterval(this.timer);
      process.stderr.write(
        `Operation observation disabled for ${this.value.id}: ${(error as Error).message}\n`,
      );
    }
  }

  private flush(): void {
    this.lastFlush = Date.now();
    this.value.updatedAt = new Date(this.lastFlush).toISOString();
    for (const file of this.files) {
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(this.value)}\n`, { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, file);
    }
    if (this.notification) {
      const temporary = `${this.notification}.${this.value.id}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ updatedAt: this.value.updatedAt }), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.notification);
    }
  }
}

// New observation directories must remain traversable even under a restrictive umask.
export function ensureRuntimeDirectory(directory: string): void {
  if (fs.existsSync(directory)) return;
  ensureRuntimeDirectory(path.dirname(directory));
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    // Another invocation can create the shared directory first.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  fs.chmodSync(directory, 0o700);
}

export function readOperations(
  directory: string,
  onInvalid?: (error: Error) => void,
): TaskOperation[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .flatMap((name) => {
      try {
        const value = JSON.parse(
          fs.readFileSync(path.join(directory, name), 'utf8'),
        ) as TaskOperation;
        validateOperationRecord(value, name.slice(0, -5));
        return [value];
      } catch (error) {
        // Another invocation may prune a completed record between list and read.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        if (!onInvalid) throw error;
        onInvalid(error as Error);
        return [];
      }
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Keep captured text bounded without copying the whole tail for every chunk. */
export class OperationOutputTail {
  private chunks: string[] = [];
  private length = 0;
  constructor(private limit = 64 * 1024 * 1024) {}
  append(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (this.length > this.limit) {
      const first = this.chunks[0];
      const remove = Math.min(first.length, this.length - this.limit);
      if (remove === first.length) this.chunks.shift();
      else this.chunks[0] = first.slice(remove);
      this.length -= remove;
    }
  }
  toString(): string {
    return this.chunks.join('');
  }
}
