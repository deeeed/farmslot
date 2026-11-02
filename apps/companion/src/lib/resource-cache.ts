import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import { ResourceCacheOwner, resourceIdentityStorageKey } from '@farmslot/local-store';
import { createNativeSqliteResourceStore } from '@farmslot/local-store/native';
import {
  createResourceCacheTransport,
  type GatewayResourceCache,
  type ResourceConnectionInputs,
} from '@farmslot/protocol/client-cache';

import { useConnectionStore } from '../store/connection';

import { startContentPrefetch } from './content-prefetch';
import { fetchRunArtifactBytes } from './held-content';
import { sharedLifetime } from './shared-lifetime';

let notice: string | undefined;
let prefetch: { cache: GatewayResourceCache; farm: boolean; stop: () => void } | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const owner = new ResourceCacheOwner({
  contentBudgetBytes: 500 * 1024 * 1024,
  identities(gatewayUrl, profileId) {
    const key = resourceIdentityStorageKey(gatewayUrl, profileId);
    return {
      load: () => AsyncStorage.getItem(key),
      save: async (identity) => {
        if (identity) await AsyncStorage.setItem(key, JSON.stringify(identity));
        else await AsyncStorage.removeItem(key);
      },
    };
  },
  openStore: (metadata) => createNativeSqliteResourceStore({ scope: metadata.scope }),
  onNotice(value) {
    notice = value;
    notify();
  },
  onError(error) {
    notice = `Offline storage could not close: ${error instanceof Error ? error.message : String(error)}`;
    notify();
  },
});
owner.subscribe(notify);
owner.subscribe(bindPrefetch);

function connectionInputs(): ResourceConnectionInputs {
  const state = useConnectionStore.getState();
  const client = state.client;
  const connected =
    client?.connectionState === 'connected' && client.gatewayUrl === state.gatewayUrl;
  return {
    id: client?.connectionGeneration ?? 0,
    connected,
    foreground: AppState.currentState === 'active',
    gatewayUrl: state.gatewayUrl,
    profileId: state.activeProfileId || undefined,
    authentication: connected ? client?.authenticatedConnection : undefined,
    reason: client?.resourceConnectionReason,
  };
}

function sync(): void {
  const state = useConnectionStore.getState();
  owner.update({
    client: state.client,
    signedOut: state.signedOut,
    connection: connectionInputs(),
  });
  // Authentication can change farm access without a new cache.
  bindPrefetch();
}

/**
 * One content prefetcher per persistent cache; it stops when that cache is retired. Farm access
 * decides whether it can read the projects' default branches, so a change restarts it.
 */
function bindPrefetch(): void {
  const cache = owner.cache;
  const farm = getResourceWorkspaceAccess() === 'farm';
  if (prefetch ? prefetch.cache === cache && prefetch.farm === farm : !cache) return;
  prefetch?.stop();
  prefetch = undefined;
  const client = useConnectionStore.getState().client;
  if (!cache || !client) return;
  prefetch = {
    cache,
    farm,
    stop: startContentPrefetch({
      cache,
      farm,
      transport: createResourceCacheTransport(client, connectionInputs),
      request: (method, params, signal) => client.request(method, params, undefined, { signal }),
      readArtifact(artifact, signal) {
        const state = useConnectionStore.getState();
        return fetchRunArtifactBytes(
          state.gatewayUrl,
          state.activeProfileHttpAuthHeaders,
          artifact,
          signal,
        );
      },
    }),
  };
}

/** Each mounted app root holds the cache; it closes only after the last root releases it. */
export const initializeNativeResourceCache = sharedLifetime(() => {
  const stopStore = useConnectionStore.subscribe(sync);
  const appState = AppState.addEventListener('change', sync);
  sync();
  return () => {
    stopStore();
    appState.remove();
    void owner.dispose().catch((error: unknown) => {
      notice = `Offline storage could not close: ${error instanceof Error ? error.message : String(error)}`;
      notify();
    });
  };
});

export function getResourceCache(): GatewayResourceCache | undefined {
  return owner.cache;
}
export function getResourceWorkspaceAccess(): 'farm' | 'native' | 'none' {
  return owner.renderMetadata?.authority.workspaceAccess ?? 'none';
}
export function getResourceWorkspaceKey(): string | undefined {
  return owner.renderKey;
}
export function getResourceStoreNotice(): string | undefined {
  return owner.cache ? notice : undefined;
}
export function subscribeResourceCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Last verified owner for native query dependencies, also available during cold offline render. */
export function getResourceNativeOwnerId(): string | undefined {
  return owner.renderMetadata?.scope.principalId;
}
