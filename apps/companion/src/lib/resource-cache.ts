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

let notice: string | undefined;
let prefetch: { cache: GatewayResourceCache; stop: () => void } | undefined;
let stopStore: (() => void) | undefined;
let stopAppState: (() => void) | undefined;
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
}

/** One content prefetcher per persistent cache; it stops when that cache is retired. */
function bindPrefetch(): void {
  const cache = owner.cache;
  if (prefetch?.cache === cache) return;
  prefetch?.stop();
  prefetch = undefined;
  const client = useConnectionStore.getState().client;
  if (!cache || !client) return;
  prefetch = {
    cache,
    stop: startContentPrefetch({
      cache,
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

export function initializeNativeResourceCache(): () => void {
  if (stopStore) return () => {};
  stopStore = useConnectionStore.subscribe(sync);
  const appState = AppState.addEventListener('change', sync);
  stopAppState = () => appState.remove();
  sync();
  return () => {
    stopStore?.();
    stopStore = undefined;
    stopAppState?.();
    stopAppState = undefined;
    void owner.dispose().catch((error: unknown) => {
      notice = `Offline storage could not close: ${error instanceof Error ? error.message : String(error)}`;
      notify();
    });
  };
}

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
