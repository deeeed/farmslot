import { AsyncLocalStorage } from 'node:async_hooks';

const executionSignal = new AsyncLocalStorage<AbortSignal | undefined>();

/** Scope leaf helpers to the signal of the graph currently executing. */
export function withRecipeExecutionSignal<T>(signal: AbortSignal | undefined, invoke: () => T): T {
  return executionSignal.run(signal, invoke);
}

export function recipeExecutionSignal(): AbortSignal | undefined {
  return executionSignal.getStore();
}
