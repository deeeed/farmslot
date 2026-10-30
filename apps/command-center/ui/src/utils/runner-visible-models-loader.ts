import { Methods, type RunnerVisibleModelsGetResult } from '@farmslot/protocol';
import { type GatewayResourceCache, resourceQuery } from '@farmslot/protocol/client-cache';

import { gateway } from '../gateway-client.js';
import {
  getResourceCache,
  getResourceNativeOwnerId,
  getResourceWorkspaceAccess,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../resource-cache.js';

import { setObservedVisibleModels } from './runner-visible-models.js';

const listeners = new Set<(error: string) => void>();
let stopOwner: (() => void) | undefined;
let stopQuery: (() => void) | undefined;
let bound: { cache?: GatewayResourceCache; owner?: string; workspace?: string } = {};
let version = 0;
let error = '';

function notify(): void {
  for (const listener of listeners) listener(error);
}

/** One shared observation of the current principal's preferences. The gateway's owner-key
 * notice refreshes it after any writer or external edit; disconnects keep the saved answer. */
function bind(): void {
  const farm =
    getResourceWorkspaceAccess() === 'farm' ||
    (gateway.connectionState === 'connected' && gateway.workspaceAccess === 'farm');
  const cache = farm ? getResourceCache() : undefined;
  const owner = getResourceNativeOwnerId();
  const workspace = getResourceWorkspaceKey();
  const same = cache === bound.cache && owner === bound.owner && workspace === bound.workspace;
  if (same && (stopQuery || !cache || !owner)) return;
  stopQuery?.();
  stopQuery = undefined;
  const current = ++version;
  if (!same) {
    // Another principal or gateway never shows the previous owner's preferences.
    setObservedVisibleModels([]);
    error = '';
  }
  bound = { cache, owner, workspace };
  if (cache && owner) {
    const stop = cache.observe(
      resourceQuery<RunnerVisibleModelsGetResult>(Methods.RUNNER_VISIBLE_MODELS_GET, {}, owner),
      (state) => {
        if (current !== version) return;
        if (state.data) setObservedVisibleModels(state.data.runners);
        // Retry must not blank the last failure before a current reply settles it.
        error = state.error?.message ?? (state.status === 'ready' ? '' : error);
        notify();
      },
    );
    if (current === version) stopQuery = stop;
    else stop();
  }
  notify();
}

/**
 * Observe every runner's visible models so views that list models without a picker
 * (Evals, Backlog, Roadmap) show the saved defaults on direct entry. Mounted views share
 * one cache query. `onChange` runs with an empty string, or with the error that kept the
 * saved defaults from loading. Returns the unsubscribe.
 */
export function watchVisibleModels(onChange: (error: string) => void): () => void {
  listeners.add(onChange);
  if (!stopOwner) {
    const stopCache = subscribeResourceCache(bind);
    const stopConnection = gateway.onConnectionChange(bind);
    stopOwner = () => {
      stopCache();
      stopConnection();
    };
    bind();
  } else onChange(error);
  return () => {
    listeners.delete(onChange);
    if (listeners.size > 0) return;
    stopOwner?.();
    stopOwner = undefined;
    stopQuery?.();
    stopQuery = undefined;
    version++;
  };
}
