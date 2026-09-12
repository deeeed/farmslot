import { execFileSync } from 'node:child_process';

interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  identity: string;
}
function processes(): Map<number, ProcessIdentity> {
  // OS process metadata only. Never inspect native stdout or process environments.
  // Start metadata survives exec and process-title changes, unlike command text.
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 1_000,
  });
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
function signal(identity: ProcessIdentity, kind: NodeJS.Signals): void {
  const current = processes().get(identity.pid);
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
    const identity = processes().get(root)?.identity;
    if (!identity) throw new Error('Native process identity is unavailable');
    this.rootIdentity = identity;
    this.capture();
  }
  capture(): void {
    const snapshot = processes();
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
    attempt(() => this.capture());
    attempt(() => this.stopGroup());
    for (const entry of [...this.owned.values()].reverse()) attempt(() => signal(entry, 'SIGKILL'));
    if (errors.length)
      throw new AggregateError(
        errors,
        `Native process tree cleanup failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
      );
  }
  empty(): boolean {
    this.capture();
    if (this.owned.size > 0) return false;
    // A reused group cannot be signaled safely or counted as proof of cleanup.
    return ![...processes().values()].some((entry) => entry.group === this.root);
  }
  private stopGroup(): void {
    const snapshot = processes();
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
