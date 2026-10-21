import { ResourceCacheOwner, resourceIdentityStorageKey } from '@farmslot/local-store';
import {
  closeBrowserResourceStores,
  createBrowserSqliteResourceStore,
} from '@farmslot/local-store/browser';
import type { GatewayResourceCache } from '@farmslot/protocol/client-cache';

import { gateway } from './gateway-client.js';

let notice: string | undefined;
let stopConnection: (() => void) | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const owner = new ResourceCacheOwner({
  identities(gatewayUrl, profileId) {
    const key = resourceIdentityStorageKey(gatewayUrl, profileId);
    return {
      load: async () => localStorage.getItem(key),
      save: async (identity) => {
        if (identity) localStorage.setItem(key, JSON.stringify(identity));
        else localStorage.removeItem(key);
      },
    };
  },
  openStore: (metadata, onNotice) =>
    createBrowserSqliteResourceStore({ scope: metadata.scope, onNotice }),
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
  const connected = gateway.connectionState === 'connected';
  owner.update({
    client: gateway,
    connection: {
      id: gateway.resourceConnectionId,
      gatewayUrl: gateway.gatewayUrl,
      connected,
      authentication: connected ? gateway.authenticatedConnection : undefined,
      reason: gateway.resourceConnectionReason,
    },
  });
}

export function initializeResourceCache(): void {
  if (stopConnection) return;
  stopConnection = gateway.onConnectionChange(sync);
  sync();
}

export function getResourceCache(): GatewayResourceCache | undefined {
  return owner.cache;
}
export function getResourceWorkspaceAccess(): 'farm' | 'native' | 'none' {
  return owner.renderIdentity?.metadata.authority.workspaceAccess ?? 'none';
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

export async function disposeResourceCache(): Promise<void> {
  stopConnection?.();
  stopConnection = undefined;
  await owner.dispose();
  closeBrowserResourceStores();
}
