import type { RunnerModelCatalogResult, RunnerVisibleModelState } from '@farmslot/protocol';
import { createReviewDispatchCatalog, type ReviewDispatchCatalog } from '@farmslot/review-dispatch';

/** Runners with no built-in model list: their pickers show each execution node's own catalog. */
export const NODE_CATALOG_RUNNERS: readonly string[] = ['pi', 'opencode'];

let observed: readonly RunnerVisibleModelState[] = [];
let catalogs: readonly RunnerModelCatalogResult[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Written only by the shared runner.visibleModels.get observation, never by reads or SET replies. */
export function setObservedVisibleModels(states: readonly RunnerVisibleModelState[]): void {
  if (JSON.stringify(states) === JSON.stringify(observed)) return;
  observed = structuredClone(states);
  notify();
}

/** Written only by the shared runner.modelCatalog observations of NODE_CATALOG_RUNNERS. */
export function setObservedRunnerCatalogs(results: readonly RunnerModelCatalogResult[]): void {
  if (JSON.stringify(results) === JSON.stringify(catalogs)) return;
  catalogs = structuredClone(results);
  notify();
}

export function onVisibleModelsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function visibleModelsObserved(): boolean {
  return observed.length > 0 || catalogs.length > 0;
}

/** True until a node-catalog runner has a listing: unread, or no execution node has listed yet. */
export function runnerCatalogPending(runner: string): boolean {
  if (!NODE_CATALOG_RUNNERS.includes(runner)) return false;
  const entry = catalogs.find((candidate) => candidate.runner === runner);
  return !entry || (entry.status !== 'ready' && entry.models.length === 0);
}

/** Null until observed, and while an unsaved runner has no seed: its shown node catalog is the set. */
export function visibleModelIds(runner: string): string[] | null {
  const state = observed.find((entry) => entry.runner === runner);
  return state && (state.configured || state.models.length) ? [...state.models] : null;
}

/** Undefined until the principal's preferences have been observed for this runner. */
export function visibleDefaultModel(runner: string): string | undefined {
  return observed.find((entry) => entry.runner === runner)?.defaultModel;
}

/** Choice/default resolution stays in the shared package. */
export function visibleReviewDispatchCatalog(): ReviewDispatchCatalog {
  return createReviewDispatchCatalog({ runnerModels: [...catalogs], visibleModels: [...observed] });
}
