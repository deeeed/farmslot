import AsyncStorage from '@react-native-async-storage/async-storage';

import { ResourceCacheOwner, resourceIdentityStorageKey } from '@farmslot/local-store';
import { createNativeSqliteResourceStore } from '@farmslot/local-store/native';
import type { GatewayResourceCache } from '@farmslot/protocol/client-cache';

import { useConnectionStore } from '../store/connection';

let notice: string | undefined;
let stopStore: (() => void) | undefined;
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

function sync(): void {
  const state = useConnectionStore.getState();
  const client = state.client;
  const connected =
    client?.connectionState === 'connected' && client.gatewayUrl === state.gatewayUrl;
  owner.update({
    client,
    signedOut: state.signedOut,
    connection: {
      id: client?.connectionGeneration ?? 0,
      connected,
      gatewayUrl: state.gatewayUrl,
      profileId: state.activeProfileId || undefined,
      authentication: connected ? client?.authenticatedConnection : undefined,
      reason: client?.resourceConnectionReason,
    },
  });
}

export function initializeNativeResourceCache(): () => void {
  if (stopStore) return () => {};
  stopStore = useConnectionStore.subscribe(sync);
  sync();
  return () => {
    stopStore?.();
    stopStore = undefined;
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
