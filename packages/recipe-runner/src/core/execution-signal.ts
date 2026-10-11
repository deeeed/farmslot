import { AsyncLocalStorage } from 'node:async_hooks';

const executionSignalKey = Symbol.for('@farmslot/recipe-runner/execution-signal');
type ExecutionSignalGlobals = typeof globalThis & {
  [executionSignalKey]?: AsyncLocalStorage<AbortSignal | undefined>;
};
const globals = globalThis as ExecutionSignalGlobals;
// A source CLI and installed providers can load separate copies of this module.
const executionSignal = (globals[executionSignalKey] ??= new AsyncLocalStorage<
  AbortSignal | undefined
>());

/** Scope leaf helpers to the signal of the graph currently executing. */
export function withRecipeExecutionSignal<T>(signal: AbortSignal | undefined, invoke: () => T): T {
  return executionSignal.run(signal, invoke);
}

export function recipeExecutionSignal(): AbortSignal | undefined {
  return executionSignal.getStore();
}
