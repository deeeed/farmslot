import type { RunnerVisibleModelState } from '@farmslot/protocol';
import { createReviewDispatchCatalog, type ReviewDispatchCatalog } from '@farmslot/review-dispatch';

let observed: readonly RunnerVisibleModelState[] = [];
const listeners = new Set<() => void>();

/** Written only by the shared runner.visibleModels.get observation, never by reads or SET replies. */
export function setObservedVisibleModels(states: readonly RunnerVisibleModelState[]): void {
  if (JSON.stringify(states) === JSON.stringify(observed)) return;
  observed = structuredClone(states);
  for (const listener of listeners) listener();
}

export function onVisibleModelsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function visibleModelsObserved(): boolean {
  return observed.length > 0;
}

export function visibleModelIds(runner: string): string[] | null {
  const state = observed.find((entry) => entry.runner === runner);
  return state ? [...state.models] : null;
}

/** Undefined until the principal's preferences have been observed for this runner. */
export function visibleDefaultModel(runner: string): string | undefined {
  return observed.find((entry) => entry.runner === runner)?.defaultModel;
}

/** Choice/default resolution stays in the shared package. */
export function visibleReviewDispatchCatalog(): ReviewDispatchCatalog {
  return createReviewDispatchCatalog({ visibleModels: [...observed] });
}
