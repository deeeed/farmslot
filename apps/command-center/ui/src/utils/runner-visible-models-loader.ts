import { Methods, type RunnerVisibleModelsGetResult } from '@farmslot/protocol';

import { gateway } from '../gateway-client.js';

import { rememberVisibleModels } from './runner-visible-cache.js';

/**
 * Load every runner's visible models each time the gateway connects, so views that
 * list models without a picker (Evals, Backlog, Roadmap) show the saved defaults on
 * direct entry. `onLoaded` runs after each load. Returns the unsubscribe.
 */
export function watchVisibleModels(onLoaded: () => void): () => void {
  let active = true;
  const load = async () => {
    const result = await gateway.request<RunnerVisibleModelsGetResult>(
      Methods.RUNNER_VISIBLE_MODELS_GET,
      {},
    );
    for (const state of result.runners) rememberVisibleModels(state.runner, state.models);
    if (active) onLoaded();
  };
  const unsubscribe = gateway.onConnectionChange((state) => {
    if (state === 'connected') void load();
  });
  if (gateway.connectionState === 'connected') void load();
  return () => {
    active = false;
    unsubscribe();
  };
}
