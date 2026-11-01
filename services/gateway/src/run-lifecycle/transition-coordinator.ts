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
 * acquire machine then run; machine workflows already holding the machine key
 * acquire only the run key, avoiding reentrant tail deadlocks.
 */
export class RunTransitionCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  /** Who holds each key and since when, so a stalled queue can name its holder. */
  private readonly holders = new Map<string, TransitionHolder>();

  constructor(
    private readonly resolveMachine: (runId: string) => Promise<string | null> = resolveRunMachine,
    private readonly waitWarnMs = TRANSITION_WAIT_WARN_MS,
  ) {}

  // Each entry point records its caller before any await, while the caller's frames still exist.
  withMachine<T>(machine: string, operation: TransitionOperation<T>): Promise<T> {
    return this.withKey(machineKey(machine), operation, new Error());
  }

  async withRun<T>(runId: string, operation: TransitionOperation<T>): Promise<T> {
    const site = new Error();
    const machine = await this.resolveMachine(runId);
    const run = () => this.withKey(runKey(runId), operation, site);
    return machine ? this.withKey(machineKey(machine), run, site) : run();
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

  /**
   * Wait for a queued key. A long wait names the holder instead of stalling silently: one line
   * per holder per interval, however many transitions wait behind it.
   */
  private async waitTurn(key: string, previous: Promise<void>, site: Error): Promise<void> {
    const enqueuedAt = Date.now();
    const turn = previous.then(() => true as const);
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ready = await Promise.race([
        turn,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.waitWarnMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      if (ready) return;
      const holder = this.holders.get(key);
      const now = Date.now();
      if (!holder || now - (holder.warnedAt ?? 0) < this.waitWarnMs) continue;
      holder.warnedAt = now;
      console.warn(
        `[run-transition] ${transitionCallerSite(site)} has waited ${Math.round((now - enqueuedAt) / 1000)}s for ${key}; held by ${transitionCallerSite(holder.site)} for ${Math.round((now - holder.since) / 1000)}s`,
      );
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
