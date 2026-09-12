import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import { NativeProcessTree } from './process-tree.js';

// Wait for the host's durable process registration before executing the native binary.
// Reading one byte leaves all subsequent native JSON on stdin untouched.
const registeredLaunch = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (fs.readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) process.exit(1);
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
child.on('error', error => { process.stderr.write(error.message); process.exit(1); });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => {
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
  else process.exit(code ?? 1);
});
`;

/** JSON framing only. Human-readable stderr never supplies session state. */
export class JsonLineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private tree?: NativeProcessTree;
  private treeTimer?: NodeJS.Timeout;
  private closed = false;
  private finish!: () => void;
  private finished = new Promise<void>((resolve) => {
    this.finish = resolve;
  });
  private cleanupError?: Error;
  private cleanupStarted = false;
  private stopTimer?: NodeJS.Timeout;
  private closing = false;
  private failure?: Error;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();

  constructor(
    executable: string,
    args: string[],
    options: {
      cwd: string;
      env?: NodeJS.ProcessEnv;
      onSpawn?: (pid: number, identity: string) => void;
    },
    onMessage: (message: Record<string, unknown>) => void,
    private readonly onExit: (error: Error | undefined, processStopped: boolean) => void,
  ) {
    const identity = `farmslot-native-${randomUUID()}`;
    this.child = spawn(
      process.execPath,
      ['-e', registeredLaunch, '--', identity, executable, ...args],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: 'pipe',
        detached: true,
      },
    );
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (this.closed) return;
      let message: Record<string, unknown>;
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Native event exceeds 1 MiB');
        const decoded: unknown = JSON.parse(line);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('Native protocol messages must be objects');
        }
        message = decoded as Record<string, unknown>;
      } catch (error) {
        this.fail(new Error('Native runner emitted invalid JSON', { cause: error }));
        this.beginStop();
        return;
      }
      if (typeof message.id === 'number' && !message.method && this.pending.has(message.id)) {
        const request = this.pending.get(message.id)!;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      } else {
        try {
          onMessage(message);
        } catch (error) {
          // A malformed runner event terminates its own session, not the gateway.
          this.fail(new Error('Native runner protocol event failed', { cause: error }));
          this.beginStop();
        }
      }
    });
    this.child.on('error', (error) => {
      this.fail(error);
      this.beginCleanup();
    });
    this.child.on('exit', (code, signal) => {
      this.fail(
        this.failure ??
          // Native signal handlers may return the conventional 128 + SIGTERM exit code.
          (this.closing &&
          (code === 0 || code === 143 || signal === 'SIGTERM' || signal === 'SIGKILL')
            ? undefined
            : new Error(`Native runner exited: code=${code}, signal=${signal}`)),
      );
      // Do not await close: descendants can retain inherited stdio after the runner exits.
      this.beginCleanup();
    });
    this.child.stdin.on('error', (error) => {
      this.fail(error);
      this.beginStop();
    });
    try {
      if (this.child.pid) {
        this.tree = new NativeProcessTree(this.child.pid);
        this.treeTimer = setInterval(() => {
          try {
            this.tree!.capture();
          } catch (error) {
            // Loss of process ownership evidence fails this session and its cleanup claim.
            this.beginCleanup(new Error('Native process census failed', { cause: error }));
          }
        }, 100);
        this.treeTimer.unref();
        options.onSpawn?.(this.child.pid, identity);
      }
      this.child.stdin.write('\n');
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.beginCleanup();
      throw error;
    }
  }

  private fail(error: Error | undefined): void {
    this.failure ??= error;
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error ?? new Error('Native runner closed'));
    }
    this.pending.clear();
  }

  write(message: unknown): void {
    if (this.closed) throw new Error('Native runner is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native request timed out: ${method}; acceptance is unknown`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private closePromise?: Promise<void>;
  close(): Promise<void> {
    this.beginStop();
    return (this.closePromise ??= this.finished.then(() => {
      if (this.cleanupError) throw this.cleanupError;
    }));
  }

  private beginStop(): void {
    if (this.closing || this.cleanupStarted) return;
    this.closing = true;
    this.fail(undefined);
    try {
      this.tree?.terminate();
      this.stopTimer = setTimeout(() => this.beginCleanup(), 3_000);
    } catch (error) {
      this.beginCleanup(new Error('Native termination failed', { cause: error }));
    }
  }

  /** Internal completion never rejects; callers of close receive any cleanup failure. */
  private beginCleanup(error?: Error): void {
    if (this.cleanupStarted) return;
    this.cleanupStarted = true;
    this.cleanupError = error;
    this.fail(error);
    clearInterval(this.treeTimer);
    clearTimeout(this.stopTimer);
    void this.cleanGroup().then(
      () => this.settle(),
      (cleanupError: unknown) => {
        this.cleanupError = new Error(
          `Native child cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { cause: cleanupError },
        );
        this.settle();
      },
    );
  }

  private settle(): void {
    // Detach host pipe handles even when cleanup failed and a descendant retained them.
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    try {
      this.onExit(this.cleanupError ?? this.failure, !this.cleanupError);
    } catch (error) {
      // The owner could not record completion. Surface that failure to close's caller.
      this.cleanupError = new Error('Native process completion could not be recorded', {
        cause: error,
      });
    } finally {
      this.finish();
    }
  }

  private async cleanGroup(): Promise<void> {
    if (!this.child.pid) return;
    if (!this.tree) {
      // The launch gate is still closed, so no native descendants have started.
      this.child.kill('SIGKILL');
      throw new Error('Native process ownership could not be established');
    }
    this.tree.stop();
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (this.tree.empty() && (this.child.exitCode !== null || this.child.signalCode !== null))
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Native child processes did not stop');
  }
}
