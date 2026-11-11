// The gateway-background host: a forked child process that runs background probes (local fleet
// slot checks, the decision walk) off the request loop. The gateway keeps the timers, the stores
// and every write; the child only returns results. Nothing forks until `start()` is called, so
// importing this module (tests, the child itself) runs every operation in-process.
import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type {
  BackgroundChildMessage,
  BackgroundOperation,
  BackgroundParams,
  BackgroundRequestMessage,
  BackgroundResult,
  ExecTally,
} from './protocol.js';

export type BackgroundHostState = 'disabled' | 'stopped' | 'starting' | 'ready' | 'restarting';

export interface BackgroundOperationFailure {
  count: number;
  message: string;
  at: string;
}

export interface BackgroundHostStatus {
  state: BackgroundHostState;
  /** When the host entered this state. */
  since: string;
  pid?: number;
  restarts: number;
  lastExit?: { code: number | null; signal: string | null; at: string };
  rssBytes?: number;
  failures: Partial<Record<BackgroundOperation, BackgroundOperationFailure>>;
  exec: Partial<Record<BackgroundOperation, ExecTally>>;
}

export interface BackgroundRequestOptions {
  /** How long the caller waits for the answer once the request is sent; a miss counts toward a wedge restart. */
  deadlineMs: number;
}

export interface BackgroundHost {
  /** Whether operations go to the background process (started and not disabled). */
  active(): boolean;
  request<O extends BackgroundOperation>(
    operation: O,
    params: BackgroundParams<O>,
    options: BackgroundRequestOptions,
  ): Promise<BackgroundResult<O>>;
  start(): void;
  stop(): Promise<void>;
  status(): BackgroundHostStatus;
}

/** The background process could not answer: it is down, restarting or stopped answering. */
export class BackgroundHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundHostError';
  }
}
export class BackgroundUnavailableError extends BackgroundHostError {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundUnavailableError';
  }
}
export class BackgroundTimeoutError extends BackgroundHostError {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundTimeoutError';
  }
}
/** The operation itself failed in the background process (the error it would throw in-process). */
export class BackgroundRequestError extends Error {
  constructor(
    readonly operation: BackgroundOperation,
    readonly causeName: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackgroundRequestError';
  }
}

export interface BackgroundHostOptions {
  entry?: string;
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  /** Delay before each restart after an exit; the last entry repeats. */
  restartDelaysMs?: readonly number[];
  /** Uptime after which the next exit restarts from the first delay again. */
  stableUptimeMs?: number;
  /** How long `stop()` waits for a clean exit before SIGKILL. */
  shutdownGraceMs?: number;
  /** How long a request waits for a starting process to become ready. */
  startupBudgetMs?: number;
}

interface PendingRequest {
  operation: BackgroundOperation;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** The startup wait, then the answer deadline once the request is sent. */
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const DEFAULT_STABLE_UPTIME_MS = 5 * 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_STARTUP_BUDGET_MS = 180_000;
/** Consecutive missed deadlines that mark the process wedged. */
const WEDGED_AFTER_MISSES = 2;

function defaultEntry(): string {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return fileURLToPath(new URL(`./child.${extension}`, import.meta.url));
}

function addTally(total: ExecTally, delta: ExecTally): ExecTally {
  const sum: ExecTally = { ...total };
  for (const [kind, value] of Object.entries(delta) as Array<
    [keyof ExecTally, { calls: number; seconds: number }]
  >) {
    const previous = sum[kind] ?? { calls: 0, seconds: 0 };
    sum[kind] = { calls: previous.calls + value.calls, seconds: previous.seconds + value.seconds };
  }
  return sum;
}

export class ForkedBackgroundHost implements BackgroundHost {
  private child?: ChildProcess;
  private readyGate: Promise<void> = new Promise(() => {});
  private openReadyGate: () => void = () => {};
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private state: BackgroundHostState = 'stopped';
  private since = new Date().toISOString();
  private restarts = 0;
  private attempt = 0;
  private startedAt = 0;
  private missedDeadlines = 0;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<void>;
  private lastExit?: BackgroundHostStatus['lastExit'];
  private rssBytes?: number;
  private readonly failures: BackgroundHostStatus['failures'] = {};
  private readonly exec: BackgroundHostStatus['exec'] = {};

  constructor(private readonly options: BackgroundHostOptions = {}) {}

  active(): boolean {
    return this.state !== 'disabled' && this.state !== 'stopped';
  }

  status(): BackgroundHostStatus {
    return {
      state: this.state,
      since: this.since,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      restarts: this.restarts,
      ...(this.lastExit ? { lastExit: this.lastExit } : {}),
      ...(this.rssBytes !== undefined ? { rssBytes: this.rssBytes } : {}),
      failures: structuredClone(this.failures),
      exec: structuredClone(this.exec),
    };
  }

  start(): void {
    if (this.active()) return;
    if ((this.options.env ?? process.env).FARMSLOT_GATEWAY_BACKGROUND === '0') {
      this.setState('disabled');
      console.log('[background] disabled (FARMSLOT_GATEWAY_BACKGROUND=0): probes run in-process');
      return;
    }
    this.stopping = undefined;
    this.spawn();
  }

  request<O extends BackgroundOperation>(
    operation: O,
    params: BackgroundParams<O>,
    { deadlineMs }: BackgroundRequestOptions,
  ): Promise<BackgroundResult<O>> {
    const child = this.child;
    if (!child || this.state === 'restarting' || !this.active()) {
      const exit = this.lastExit
        ? ` after exit (code ${this.lastExit.code}, signal ${this.lastExit.signal}) at ${this.lastExit.at}`
        : '';
      const error = new BackgroundUnavailableError(
        `The gateway background process is ${this.state}${exit}`,
      );
      this.recordFailure(operation, error.message);
      return Promise.reject(error);
    }
    const id = this.nextId++;
    // A generic operation and its params form one member of the request union.
    const message = { type: 'request', id, operation, params } as BackgroundRequestMessage;
    return new Promise<BackgroundResult<O>>((resolve, reject) => {
      const pending: PendingRequest = {
        operation,
        // The child built this value from the same operation contract.
        resolve: (value) => resolve(value as BackgroundResult<O>),
        reject,
      };
      this.pending.set(id, pending);
      // A cold start (importing the probe modules) can take a while under load. Waiting for it is
      // not a missed deadline, so it never counts toward a wedge restart.
      const startupMs = this.options.startupBudgetMs ?? DEFAULT_STARTUP_BUDGET_MS;
      pending.timer = setTimeout(() => {
        const error = new BackgroundUnavailableError(
          `The gateway background process did not become ready within ${startupMs} ms`,
        );
        this.recordFailure(operation, error.message);
        this.settle(id, error);
      }, startupMs);
      pending.timer.unref();
      // The child attaches its message handler once its imports finish; it says so with `ready`.
      void this.readyGate.then(() => {
        if (!this.pending.has(id) || this.child !== child || !child.connected) return;
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          const error = new BackgroundTimeoutError(
            `The gateway background process did not answer ${operation} within ${deadlineMs} ms`,
          );
          this.recordFailure(operation, error.message);
          this.settle(id, error);
          this.deadlineMissed(child);
        }, deadlineMs);
        pending.timer.unref();
        child.send(message, (error) => {
          if (error) this.settle(id, new BackgroundUnavailableError(error.message));
        });
      });
    });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    if (!child) {
      if (this.state !== 'disabled') this.setState('stopped');
      this.stopping = Promise.resolve();
      return this.stopping;
    }
    this.stopping = new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        console.error(`[background] pid ${child.pid} did not stop; sending SIGKILL`);
        child.kill('SIGKILL');
      }, this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
      kill.unref();
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      if (child.connected) child.send({ type: 'shutdown' });
      else child.kill('SIGTERM');
    });
    return this.stopping;
  }

  private setState(state: BackgroundHostState): void {
    this.state = state;
    this.since = new Date().toISOString();
  }

  private spawn(): void {
    this.restartTimer = undefined;
    this.setState('starting');
    this.readyGate = new Promise((resolve) => {
      this.openReadyGate = resolve;
    });
    const child = fork(this.options.entry ?? defaultEntry(), [], {
      execArgv: this.options.execArgv ?? process.execArgv,
      env: this.options.env ?? process.env,
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.child = child;
    this.startedAt = Date.now();
    child.on('message', (message: BackgroundChildMessage) => this.receive(child, message));
    child.on('exit', (code, signal) => this.exited(child, code, signal));
    child.on('error', (error) => {
      console.error(`[background] process error: ${error.message}`);
      // A process that never started emits no exit; account for it as one.
      if (child.pid === undefined) this.exited(child, null, null);
    });
  }

  private receive(child: ChildProcess, message: BackgroundChildMessage): void {
    if (child !== this.child) return;
    if (message.type === 'ready') {
      this.rssBytes = message.rssBytes;
      this.setState('ready');
      console.log(
        `[background] ready pid=${message.pid} rss=${Math.round(message.rssBytes / 1_048_576)}MB`,
      );
      this.openReadyGate();
      return;
    }
    this.rssBytes = message.rssBytes;
    if (Object.keys(message.exec).length)
      this.exec[message.operation] = addTally(this.exec[message.operation] ?? {}, message.exec);
    if (!this.pending.has(message.id)) return; // the caller's deadline already passed
    this.missedDeadlines = 0;
    if (message.ok) this.settle(message.id, undefined, message.value);
    else {
      this.recordFailure(message.operation, message.error.message);
      this.settle(
        message.id,
        new BackgroundRequestError(message.operation, message.error.name, message.error.message),
      );
    }
  }

  private settle(id: number, error?: Error, value?: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private deadlineMissed(child: ChildProcess): void {
    if (child !== this.child) return;
    this.missedDeadlines++;
    if (this.missedDeadlines < WEDGED_AFTER_MISSES) return;
    this.missedDeadlines = 0;
    console.error(
      `[background] pid ${child.pid} missed ${WEDGED_AFTER_MISSES} deadlines in a row; restarting it`,
    );
    child.kill('SIGKILL');
  }

  private exited(child: ChildProcess, code: number | null, signal: string | null): void {
    if (child !== this.child) return;
    this.child = undefined;
    this.missedDeadlines = 0;
    this.lastExit = { code, signal, at: new Date().toISOString() };
    for (const [id, pending] of [...this.pending]) {
      const error = new BackgroundUnavailableError(
        `The gateway background process exited (code ${code}, signal ${signal}) during ${pending.operation}`,
      );
      this.recordFailure(pending.operation, error.message);
      this.settle(id, error);
    }
    if (this.stopping) {
      this.setState('stopped');
      return;
    }
    const delays = this.options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    if (Date.now() - this.startedAt >= (this.options.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS))
      this.attempt = 0;
    const delay = delays[Math.min(this.attempt, delays.length - 1)]!;
    this.attempt++;
    this.restarts++;
    this.setState('restarting');
    console.error(
      `[background] exited (code ${code}, signal ${signal}); restart ${this.restarts} in ${delay} ms`,
    );
    this.restartTimer = setTimeout(() => this.spawn(), delay);
    this.restartTimer.unref();
  }

  private recordFailure(operation: BackgroundOperation, message: string): void {
    this.failures[operation] = {
      count: (this.failures[operation]?.count ?? 0) + 1,
      message,
      at: new Date().toISOString(),
    };
  }
}

export const backgroundHost: BackgroundHost = new ForkedBackgroundHost();
