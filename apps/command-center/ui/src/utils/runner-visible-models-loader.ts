import { Methods, type RunnerVisibleModelsGetResult } from '@farmslot/protocol';

import { gateway } from '../gateway-client.js';

import {
  clearVisibleModels,
  onVisibleModelsChange,
  rememberVisibleModels,
} from './runner-visible-cache.js';

const listeners = new Set<(error: string) => void>();
let unsubscribeConnection: (() => void) | null = null;
let latestLoad = 0;
let unsubscribeVisible: (() => void) | null = null;

async function loadVisibleModels(): Promise<void> {
  const load = ++latestLoad;
  let result: RunnerVisibleModelsGetResult;
  try {
    result = await gateway.request<RunnerVisibleModelsGetResult>(
      Methods.RUNNER_VISIBLE_MODELS_GET,
      {},
    );
  } catch (err) {
    if (load !== latestLoad) return;
    // The socket dropped while the request was pending. The next 'connected'
    // event loads again, so this attempt has nothing left to do.
    if (gateway.connectionState !== 'connected') return;
    // Any other failure leaves the lists on the built-in defaults. Views show why.
    const message = err instanceof Error ? err.message : String(err);
    for (const listener of listeners) listener(message);
    return;
  }
  // A later load started after this one; its answer is the current one.
  if (load !== latestLoad) return;
  for (const state of result.runners)
    rememberVisibleModels(state.runner, state.models, state.defaultModel);
  for (const listener of listeners) listener('');
}

/**
 * Load every runner's visible models each time the gateway connects, so views that
 * list models without a picker (Evals, Backlog, Roadmap) show the saved defaults on
 * direct entry. Mounted views share one load. `onLoaded` runs after each load with
 * an empty string, or with the error that kept the saved defaults from loading.
 * Returns the unsubscribe.
 */
export function watchVisibleModels(onLoaded: (error: string) => void): () => void {
  listeners.add(onLoaded);
  if (!unsubscribeConnection) {
    unsubscribeVisible = onVisibleModelsChange(() => {
      for (const listener of listeners) listener('');
    });
    unsubscribeConnection = gateway.onConnectionChange((state) => {
      if (state === 'connected') void loadVisibleModels();
      else {
        latestLoad++;
        clearVisibleModels();
      }
    });
    if (gateway.connectionState === 'connected') void loadVisibleModels();
  }
  return () => {
    listeners.delete(onLoaded);
    if (listeners.size > 0) return;
    unsubscribeConnection?.();
    unsubscribeConnection = null;
    unsubscribeVisible?.();
    unsubscribeVisible = null;
  };
}
