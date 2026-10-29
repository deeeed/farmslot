import { AsyncLocalStorage } from 'node:async_hooks';

const cleanup = new AsyncLocalStorage<AbortSignal>();

/** Nested releases inherit the terminal cleanup's cancellation. */
export function cleanupSignal(signal?: AbortSignal): AbortSignal | undefined {
  const parent = cleanup.getStore();
  return parent && signal ? AbortSignal.any([parent, signal]) : parent ?? signal;
}

export function assertCleanupCurrent(): void {
  cleanup.getStore()?.throwIfAborted();
}

export function withCleanupSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return cleanup.run(signal, operation);
}
