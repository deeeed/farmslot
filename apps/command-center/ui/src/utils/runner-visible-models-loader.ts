import { Methods, type RunnerVisibleModelsGetResult } from '@farmslot/protocol';

import { gateway } from '../gateway-client.js';

import { rememberVisibleModels } from './runner-visible-cache.js';

const listeners = new Set<() => void>();
let unsubscribeConnection: (() => void) | null = null;
let latestLoad = 0;

async function loadVisibleModels(): Promise<void> {
  const load = ++latestLoad;
  let result: RunnerVisibleModelsGetResult;
  try {
    result = await gateway.request<RunnerVisibleModelsGetResult>(
      Methods.RUNNER_VISIBLE_MODELS_GET,
      {},
    );
  } catch (err) {
    // The socket dropped while the request was pending. The next 'connected'
    // event loads again, so this attempt has nothing left to do.
    if (gateway.connectionState !== 'connected') return;
    throw err;
  }
  // A later load started after this one; its answer is the current one.
  if (load !== latestLoad) return;
  for (const state of result.runners) rememberVisibleModels(state.runner, state.models);
  for (const listener of listeners) listener();
}

/**
 * Load every runner's visible models each time the gateway connects, so views that
 * list models without a picker (Evals, Backlog, Roadmap) show the saved defaults on
 * direct entry. Mounted views share one load. `onLoaded` runs after each load.
 * Returns the unsubscribe.
 */
export function watchVisibleModels(onLoaded: () => void): () => void {
  listeners.add(onLoaded);
  if (!unsubscribeConnection) {
    unsubscribeConnection = gateway.onConnectionChange((state) => {
      if (state === 'connected') void loadVisibleModels();
    });
    if (gateway.connectionState === 'connected') void loadVisibleModels();
  }
  return () => {
    listeners.delete(onLoaded);
    if (listeners.size > 0) return;
    unsubscribeConnection?.();
    unsubscribeConnection = null;
  };
}
