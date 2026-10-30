import { AsyncLocalStorage } from 'node:async_hooks';

export interface CleanupCommands {
  pending: Set<Promise<unknown>>;
  unconfirmed: boolean;
}
interface CleanupScope {
  signal: AbortSignal;
  commands: CleanupCommands;
  parent?: CleanupScope;
}
const cleanup = new AsyncLocalStorage<CleanupScope>();

/** Nested releases inherit the terminal cleanup's cancellation. */
export function cleanupSignal(signal?: AbortSignal): AbortSignal | undefined {
  const parent = cleanup.getStore()?.signal;
  return parent && signal ? AbortSignal.any([parent, signal]) : (parent ?? signal);
}
export function assertCleanupCurrent(): void {
  cleanup.getStore()?.signal.throwIfAborted();
}
export function withCleanupSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  commands: CleanupCommands = { pending: new Set(), unconfirmed: false },
): Promise<T> {
  return cleanup.run({ signal, commands, parent: cleanup.getStore() }, operation);
}

/** A command stays owned until its transport/process closeout settles. */
export function trackCleanupCommand<T>(command: Promise<T>): Promise<T> {
  for (let scope = cleanup.getStore(); scope; scope = scope.parent) {
    const commands = scope.commands;
    commands.pending.add(command);
    command.then(
      () => {
        commands.pending.delete(command);
      },
      () => {
        commands.unconfirmed = true;
        commands.pending.delete(command);
      },
    );
  }
  return command;
}

export async function drainCleanupCommands(
  commands: CleanupCommands,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (!commands.pending.size) return !commands.unconfirmed;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stopped = await Promise.race([
      Promise.allSettled([...commands.pending]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    return stopped && !commands.unconfirmed;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Independent work and recovery under a captured claim must leave the old cleanup. */
export function withoutCleanupSignal<T>(operation: () => T): T {
  return cleanup.exit(operation);
}
