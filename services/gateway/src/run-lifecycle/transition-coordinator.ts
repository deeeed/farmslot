import { loadSlotVars } from '../core/config.js';
import { getRun } from '../runs/store.js';

type TransitionOperation<T> = () => Promise<T>;

interface TransitionHolder {
  /** Captured at the entry point; formatted only when a wait is reported. */
  site: Error;
  since: number;
  warnedAt?: number;
}

/** A transition queued this long names the operation holding its key, and again each interval. */
const TRANSITION_WAIT_WARN_MS = 60_000;

/** The first caller frame outside this module, formatted only when a wait is reported. */
function transitionCallerSite(site: Error): string {
  const frames = site.stack?.split('\n').slice(1) ?? [];
  const caller = frames.find((frame) => !/transition-coordinator\.[jt]s:/u.test(frame));
  return caller?.trim().replace(/^at /u, '') ?? 'unknown caller';
}

/**
 * Serializes machine- and run-scoped lifecycle mutations. Public run actions
 * share their machine's key and take their run's key; a machine workflow takes
 * the machine key alone, after the run actions in flight on it, and then only
 * run keys, avoiding reentrant tail deadlocks. Run actions on two slots of one
 * machine never wait for each other: a cancel queued for 8 minutes behind
 * another run's publish package refresh on macpro (F314).
 */
export class RunTransitionCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  /** Who holds each key and since when, so a stalled queue can name its holder. */
  private readonly holders = new Map<string, TransitionHolder>();
  /** Run actions in flight on each machine key; a machine workflow waits until none are left. */
  private readonly sharers = new Map<string, Set<TransitionHolder>>();
  private readonly drained = new Map<string, { promise: Promise<void>; resolve(): void }>();

  constructor(
    private readonly resolveMachine: (runId: string) => Promise<string | null> = resolveRunMachine,
    private readonly waitWarnMs = TRANSITION_WAIT_WARN_MS,
  ) {}

  // Each entry point records its caller before any await, while the caller's frames still exist.
  withMachine<T>(machine: string, operation: TransitionOperation<T>): Promise<T> {
    const site = new Error();
    const key = machineKey(machine);
    return this.withKey(
      key,
      async () => {
        await this.waitForSharers(key, site);
        return operation();
      },
      site,
    );
  }

  async withRun<T>(runId: string, operation: TransitionOperation<T>): Promise<T> {
    const site = new Error();
    const machine = await this.resolveMachine(runId);
    const run = () => this.withKey(runKey(runId), operation, site);
    return machine ? this.withSharedKey(machineKey(machine), run, site) : run();
  }

  withRunWhileMachineHeld<T>(runId: string, operation: TransitionOperation<T>): Promise<T> {
    return this.withKey(runKey(runId), operation, new Error());
  }

  withReviewBudget<T>(scope: string, operation: TransitionOperation<T>): Promise<T> {
    return this.withKey(`review-budget:${scope}`, operation, new Error());
  }

  private async withKey<T>(
    key: string,
    operation: TransitionOperation<T>,
    site: Error,
  ): Promise<T> {
    const queued = this.tails.get(key);
    const previous = queued ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    if (queued) await this.waitTurn(key, queued, site);
    else await previous;
    const holder: TransitionHolder = { site, since: Date.now() };
    this.holders.set(key, holder);
    try {
      return await operation();
    } finally {
      if (this.holders.get(key) === holder) this.holders.delete(key);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Hold `key` alongside other sharers once no machine workflow holds or awaits it. */
  private async withSharedKey<T>(
    key: string,
    operation: TransitionOperation<T>,
    site: Error,
  ): Promise<T> {
    // Joining is synchronous with the last check, so a workflow queued after it waits for us.
    for (let exclusive = this.tails.get(key); exclusive; exclusive = this.tails.get(key))
      await this.waitTurn(key, exclusive, site);
    const holder: TransitionHolder = { site, since: Date.now() };
    const sharers = this.sharers.get(key) ?? new Set<TransitionHolder>();
    sharers.add(holder);
    this.sharers.set(key, sharers);
    try {
      return await operation();
    } finally {
      sharers.delete(holder);
      if (!sharers.size) {
        this.sharers.delete(key);
        this.drained.get(key)?.resolve();
        this.drained.delete(key);
      }
    }
  }

  /** A machine workflow holding `key` waits for the run actions that started before it. */
  private async waitForSharers(key: string, site: Error): Promise<void> {
    const enqueuedAt = Date.now();
    for (;;) {
      const sharers = this.sharers.get(key);
      if (!sharers?.size) return;
      let drained = this.drained.get(key);
      if (!drained) {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        drained = { promise, resolve };
        this.drained.set(key, drained);
      }
      if (await this.settlesWithin(drained.promise)) continue;
      const oldest = [...sharers].reduce((a, b) => (b.since < a.since ? b : a));
      this.warnWait(key, site, enqueuedAt, oldest);
    }
  }

  private async settlesWithin(promise: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise.then(() => true as const),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.waitWarnMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private warnWait(key: string, site: Error, enqueuedAt: number, holder: TransitionHolder): void {
    const now = Date.now();
    if (now - (holder.warnedAt ?? 0) < this.waitWarnMs) return;
    holder.warnedAt = now;
    console.warn(
      `[run-transition] ${transitionCallerSite(site)} has waited ${Math.round((now - enqueuedAt) / 1000)}s for ${key}; held by ${transitionCallerSite(holder.site)} for ${Math.round((now - holder.since) / 1000)}s`,
    );
  }

  /**
   * Wait for a queued key. A long wait names the holder instead of stalling silently: one line
   * per holder per interval, however many transitions wait behind it.
   */
  private async waitTurn(key: string, previous: Promise<void>, site: Error): Promise<void> {
    const enqueuedAt = Date.now();
    for (;;) {
      if (await this.settlesWithin(previous)) return;
      const holder = this.holders.get(key);
      if (holder) this.warnWait(key, site, enqueuedAt, holder);
    }
  }
}

async function resolveRunMachine(runId: string): Promise<string | null> {
  const run = getRun(runId);
  if (!run) return null;
  if (run.park?.machine) return run.park.machine;
  if (!run.slotId) return null;
  try {
    return (await loadSlotVars(run.slotId)).machine;
  } catch {
    // The run key still serializes mutations when a stale/missing slot can no
    // longer resolve its machine. Callers retain their normal not-found guard.
    return null;
  }
}

function machineKey(machine: string): string {
  return `machine:${machine}`;
}

function runKey(runId: string): string {
  return `run:${runId}`;
}

export const runTransitionCoordinator = new RunTransitionCoordinator();

export const withMachineRunTransition = <T>(machine: string, operation: TransitionOperation<T>) =>
  runTransitionCoordinator.withMachine(machine, operation);

export const withRunTransition = <T>(runId: string, operation: TransitionOperation<T>) =>
  runTransitionCoordinator.withRun(runId, operation);

/** Hold the existing transition across replay's claim-to-revive interval. */
export async function acquireRunTransition(runId: string): Promise<() => Promise<void>> {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completion = withRunTransition(runId, async () => {
    entered();
    await held;
  });
  await Promise.race([ready, completion]);
  return async () => {
    release();
    await completion;
  };
}

export const withRunTransitionWhileMachineHeld = <T>(
  runId: string,
  operation: TransitionOperation<T>,
) => runTransitionCoordinator.withRunWhileMachineHeld(runId, operation);
