import { loadSlotVars } from '../core/config.js';
import { getRun } from '../runs/store.js';

type TransitionOperation<T> = () => Promise<T>;

/**
 * Serializes machine- and run-scoped lifecycle mutations. Public run actions
 * acquire machine then run; machine workflows already holding the machine key
 * acquire only the run key, avoiding reentrant tail deadlocks.
 */
export class RunTransitionCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly resolveMachine: (runId: string) => Promise<string | null> = resolveRunMachine,
  ) {}

  withMachine<T>(machine: string, operation: TransitionOperation<T>): Promise<T> {
    return this.withKey(machineKey(machine), operation);
  }

  async withRun<T>(runId: string, operation: TransitionOperation<T>): Promise<T> {
    const machine = await this.resolveMachine(runId);
    if (!machine) return this.withRunWhileMachineHeld(runId, operation);
    return this.withMachine(machine, () => this.withRunWhileMachineHeld(runId, operation));
  }

  withRunWhileMachineHeld<T>(runId: string, operation: TransitionOperation<T>): Promise<T> {
    return this.withKey(runKey(runId), operation);
  }

  private async withKey<T>(key: string, operation: TransitionOperation<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
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

export const withRunTransitionWhileMachineHeld = <T>(
  runId: string,
  operation: TransitionOperation<T>,
) => runTransitionCoordinator.withRunWhileMachineHeld(runId, operation);
