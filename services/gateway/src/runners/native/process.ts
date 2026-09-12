import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** JSON framing only. Human-readable stderr never supplies session state. */
export class JsonLineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private closed = false;
  private exited = false;
  private closing = false;
  private failure?: Error;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();

  constructor(
    executable: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
    onMessage: (message: Record<string, unknown>) => void,
    onExit: (error?: Error) => void,
  ) {
    this.child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: 'pipe' });
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (this.closed) return;
      let message: Record<string, unknown>;
      try {
        const decoded: unknown = JSON.parse(line);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('Native protocol messages must be objects');
        }
        message = decoded as Record<string, unknown>;
      } catch (error) {
        this.fail(new Error('Native runner emitted invalid JSON', { cause: error }));
        this.child.kill();
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
          this.child.kill();
        }
      }
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('close', (code, signal) => {
      this.exited = true;
      this.fail(
        this.failure ??
          (code === 0 || (this.closing && (signal === 'SIGTERM' || signal === 'SIGKILL'))
            ? undefined
            : new Error(`Native runner exited: code=${code}, signal=${signal}`)),
      );
      onExit(this.failure);
    });
    this.child.stdin.on('error', (error) => {
      this.fail(error);
      this.child.kill();
    });
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

  async close(): Promise<void> {
    if (this.exited) return;
    this.closing = true;
    this.fail(undefined);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 3_000);
      this.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }
}
