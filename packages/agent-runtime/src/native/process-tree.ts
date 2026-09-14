import { execFile, execFileSync } from 'node:child_process';

interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  identity: string;
}
const columns = 'pid=,ppid=,pgid=,lstart=';
const censusTimeoutMs = 5_000;
function parseProcesses(output: string): Map<number, ProcessIdentity> {
  const result = new Map<number, ProcessIdentity>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match)
      result.set(Number(match[1]), {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        identity: match[4]!,
      });
  }
  return result;
}
function processes(pid?: number): Map<number, ProcessIdentity> {
  // OS process metadata only. Never inspect native stdout or process environments.
  // Start metadata survives exec and process-title changes, unlike command text.
  let output: string;
  try {
    output = execFileSync(
      'ps',
      pid === undefined ? ['-axo', columns] : ['-p', String(pid), '-o', columns],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
        timeout: censusTimeoutMs,
        killSignal: 'SIGKILL',
      },
    );
  } catch (error) {
    if (pid !== undefined && (error as { status?: number }).status === 1) {
      try {
        process.kill(pid, 0);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') return new Map();
        throw probeError;
      }
    }
    throw error;
  }
  return parseProcesses(output);
}

type Observer = { apply(snapshot: Map<number, ProcessIdentity>): void; failed(error: Error): void };
const observers = new Map<symbol, Observer>();
let censusTimer: NodeJS.Timeout | undefined;
let scanning = false;
let stalledCensus: Error | undefined;
function scheduleCensus(): void {
  if (!observers.size || censusTimer || scanning) return;
  censusTimer = setTimeout(() => {
    censusTimer = undefined;
    scanning = true;
    const participants = [...observers.entries()];
    let expired = false;
    let deadline: NodeJS.Timeout | undefined;
    const child = execFile(
      'ps',
      ['-axo', columns],
      {
        encoding: 'utf8',
        timeout: censusTimeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, output) => {
        clearTimeout(deadline);
        scanning = false;
        stalledCensus = undefined;
        if (expired) {
          // A late callback cannot rehabilitate the snapshot that missed its deadline.
          scheduleCensus();
          return;
        }
        const snapshot = error ? undefined : parseProcesses(output);
        for (const [token, observer] of participants) {
          // A scan started before registration or disposal cannot update that tree.
          if (observers.get(token) !== observer) continue;
          if (error) observer.failed(error);
          else observer.apply(snapshot!);
        }
        scheduleCensus();
      },
    );
    deadline = setTimeout(() => {
      expired = true;
      stalledCensus = new Error('Native process census exceeded its deadline');
      child.kill('SIGKILL');
      // execFile's timeout waits for child/pipe closure before its callback. Fail
      // ownership observation now, keeping this scan reserved until it really exits.
      for (const observer of [...observers.values()]) observer.failed(stalledCensus);
    }, censusTimeoutMs);
    deadline.unref();
  }, 100);
  censusTimer.unref();
}
function signal(identity: ProcessIdentity, kind: NodeJS.Signals): void {
  const current = processes(identity.pid).get(identity.pid);
  if (!current || current.identity !== identity.identity) return;
  try {
    process.kill(identity.pid, kind);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
/** Tracks detached descendants while their ancestry is still observable. */
export class NativeProcessTree {
  private owned = new Map<number, ProcessIdentity>();
  private readonly rootIdentity: string;
  constructor(private readonly root: number) {
    const snapshot = processes();
    const identity = snapshot.get(root)?.identity;
    if (!identity) throw new Error('Native process identity is unavailable');
    this.rootIdentity = identity;
    this.applySnapshot(snapshot);
  }
  capture(): void {
    this.applySnapshot(processes());
  }
  observe(failed: (error: Error) => void): () => void {
    const token = Symbol('native-process-census');
    observers.set(token, { apply: (snapshot) => this.applySnapshot(snapshot), failed });
    if (stalledCensus) {
      const error = stalledCensus;
      queueMicrotask(() => {
        if (observers.has(token)) failed(error);
      });
    }
    scheduleCensus();
    return () => {
      observers.delete(token);
      if (!observers.size) {
        clearTimeout(censusTimer);
        censusTimer = undefined;
      }
    };
  }
  private applySnapshot(snapshot: Map<number, ProcessIdentity>): void {
    const root = snapshot.get(this.root);
    if (root?.identity === this.rootIdentity) {
      this.owned.set(root.pid, root);
    }
    for (const [pid, identity] of this.owned) {
      if (snapshot.get(pid)?.identity !== identity.identity) this.owned.delete(pid);
    }
    // A current, known member proves this is still the original runner group.
    const ownsGroup = [...this.owned.values()].some((entry) => entry.group === this.root);
    if (ownsGroup) {
      for (const entry of snapshot.values()) {
        if (entry.group === this.root) this.owned.set(entry.pid, entry);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of snapshot.values()) {
        if (!this.owned.has(entry.pid) && this.owned.has(entry.parent)) {
          this.owned.set(entry.pid, entry);
          changed = true;
        }
      }
    }
  }
  /** Last observed identities remain useful when a later census cannot be read. */
  snapshot(): ProcessIdentity[] {
    return [...this.owned.values()].map((identity) => ({ ...identity }));
  }
  /** Freeze observed owners before the final ancestry scan, preventing new child launches. */
  stop(): void {
    this.capture();
    const errors: unknown[] = [];
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        // Continue trying the other owned processes, but never claim successful cleanup.
        errors.push(error);
      }
    };
    for (const entry of this.owned.values()) attempt(() => signal(entry, 'SIGSTOP'));
    attempt(() => {
      const frozen = processes();
      this.applySnapshot(frozen);
      this.stopGroup(frozen);
    });
    for (const entry of [...this.owned.values()].reverse()) attempt(() => signal(entry, 'SIGKILL'));
    if (errors.length)
      throw new AggregateError(
        errors,
        `Native process tree cleanup failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
      );
  }
  empty(): boolean {
    const snapshot = processes();
    this.applySnapshot(snapshot);
    if (this.owned.size > 0) return false;
    // A reused group cannot be signaled safely or counted as proof of cleanup.
    return ![...snapshot.values()].some((entry) => entry.group === this.root);
  }
  private stopGroup(snapshot: Map<number, ProcessIdentity>): void {
    const members = [...snapshot.values()].filter((entry) => entry.group === this.root);
    if (!members.length) return;
    if (!members.some((entry) => this.owned.get(entry.pid)?.identity === entry.identity))
      throw new Error('Native process group ownership could not be verified');
    try {
      process.kill(-this.root, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  /** Graceful stop begins with the native root, retaining descendants for final cleanup. */
  terminate(): void {
    this.capture();
    const root = this.owned.get(this.root);
    if (root) signal(root, 'SIGTERM');
  }
}
