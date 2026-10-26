import { ResourceCacheOwner, resourceIdentityStorageKey } from '@farmslot/local-store';
import {
  closeBrowserResourceStores,
  createBrowserSqliteResourceStore,
} from '@farmslot/local-store/browser';
import type { GatewayResourceCache, ResourceStoreMetadata } from '@farmslot/protocol/client-cache';

import { gateway } from './gateway-client.js';

let notice: string | undefined;
let stopConnection: (() => void) | undefined;
let suspended = false;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
function reportCloseError(error: unknown): void {
  notice = `Offline storage could not close: ${error instanceof Error ? error.message : String(error)}`;
  notify();
}
const owner = new ResourceCacheOwner({
  contentBudgetBytes: 2 * 1024 * 1024 * 1024,
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
  onError: reportCloseError,
});
owner.subscribe(notify);

function sync(): void {
  if (suspended) return;
  const connected = gateway.connectionState === 'connected';
  owner.update({
    client: gateway,
    connection: {
      id: gateway.resourceConnectionId,
      gatewayUrl: gateway.gatewayUrl,
      connected,
      foreground: document.visibilityState !== 'hidden',
      authentication: connected ? gateway.authenticatedConnection : undefined,
      reason: gateway.resourceConnectionReason,
    },
  });
}

function suspendForNavigation(): void {
  suspended = true;
  // Retire observations before stopping the worker. Chromium can otherwise
  // destroy its OPFS remotes while a queued synchronous write is still running.
  const retiring = owner.dispose();
  closeBrowserResourceStores();
  void retiring.catch(reportCloseError);
}

function resumeFromNavigation(event: PageTransitionEvent): void {
  if (!event.persisted || !suspended) return;
  suspended = false;
  // A restored document must reauthenticate and read on a new connection.
  gateway.reconnect();
  sync();
}

export function initializeResourceCache(): void {
  if (stopConnection) return;
  suspended = false;
  window.addEventListener('pagehide', suspendForNavigation);
  window.addEventListener('pageshow', resumeFromNavigation);
  document.addEventListener('visibilitychange', sync);
  stopConnection = gateway.onConnectionChange(sync);
  sync();
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
export function getResourceStoreMetadata(): ResourceStoreMetadata | undefined {
  return owner.renderMetadata;
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
  window.removeEventListener('pagehide', suspendForNavigation);
  window.removeEventListener('pageshow', resumeFromNavigation);
  document.removeEventListener('visibilitychange', sync);
  suspended = false;
  const retiring = owner.dispose();
  closeBrowserResourceStores();
  await retiring;
}

/** Last verified owner for native query dependencies, also available during cold offline render. */
export function getResourceNativeOwnerId(): string | undefined {
  return owner.renderMetadata?.scope.principalId;
}
