// Invocation records keep concurrent command observations independent of locks.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type TaskOperation, validateOperationRecord } from '@farmslot/protocol';

export function processIdentity(pid: number): string | undefined {
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return value || undefined;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return undefined;
    throw error;
  }
}

export class OperationRecord {
  readonly file: string;
  readonly value: TaskOperation;
  private readonly files: string[];
  private readonly timer: ReturnType<typeof setInterval>;
  private lastFlush = 0;
  private disabled = false;
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
    if (!identity) throw new Error('Cannot identify the operation owner process');
    this.value = {
      schemaVersion: 1,
      id,
      ...(options.parentId ? { parentId: options.parentId } : {}),
      command,
      target,
      pid: process.pid,
      processStartedAt: identity,
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
    this.observe(() => {
      fs.appendFileSync(this.value.logPath, chunk);
      this.value.lastOutputAt = new Date().toISOString();
      if (Date.now() - this.lastFlush >= 1000) this.flush();
    });
  }

  finish(exitCode: number): void {
    clearInterval(this.timer);
    this.value.exitCode = exitCode;
    this.value.status = exitCode === 0 ? 'pass' : 'fail';
    this.value.finishedAt = new Date().toISOString();
    this.observe(() => this.flush());
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
