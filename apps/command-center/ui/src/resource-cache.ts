import { ResourceCacheOwner, resourceIdentityStorageKey } from '@farmslot/local-store';
import {
  closeBrowserResourceStores,
  createBrowserSqliteResourceStore,
} from '@farmslot/local-store/browser';
import type { Run } from '@farmslot/protocol';
import {
  type ContentPrefetchTarget,
  createResourceCacheTransport,
  type GatewayResourceCache,
  type ResourceConnectionInputs,
  type ResourceStoreMetadata,
} from '@farmslot/protocol/client-cache';

import { createOwnerContentPrefetch, fetchRunArtifactBytes } from './content-prefetch.js';
import { gateway } from './gateway-client.js';

let notice: string | undefined;
/** The owned cache whose store is persistent; only this tab's owner store prefetches. */
let persistentCache: GatewayResourceCache | undefined;
let slotBase: ((run: Run) => string | undefined) | undefined;
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
  async openStore(metadata, onNotice) {
    const store = await createBrowserSqliteResourceStore({ scope: metadata.scope, onNotice });
    persistentCache = store.persistent ? owner.cache : undefined;
    syncContentPrefetch();
    return store;
  },
  onNotice(value) {
    notice = value;
    notify();
  },
  onError: reportCloseError,
});

function connectionInputs(): ResourceConnectionInputs {
  const connected = gateway.connectionState === 'connected';
  return {
    id: gateway.resourceConnectionId,
    gatewayUrl: gateway.gatewayUrl,
    connected,
    foreground: document.visibilityState !== 'hidden',
    authentication: connected ? gateway.authenticatedConnection : undefined,
    reason: gateway.resourceConnectionReason,
  };
}

const contentPrefetch = createOwnerContentPrefetch({
  transport: createResourceCacheTransport(
    {
      get resourceConnectionReason() {
        return gateway.resourceConnectionReason;
      },
      requestResource: (method, params, signal) => gateway.requestResource(method, params, signal),
      subscribe: (event, listener) => gateway.subscribe(event, listener),
      reconnect: () => gateway.reconnect(),
      onConnectionChange(listener) {
        // A hidden tab pauses prefetch, so visibility counts as a connection change.
        const stop = gateway.onConnectionChange(() => listener());
        document.addEventListener('visibilitychange', listener);
        return () => {
          stop();
          document.removeEventListener('visibilitychange', listener);
        };
      },
    },
    connectionInputs,
  ),
  request: (method, params, signal) => gateway.request(method, params, { signal }),
  readArtifact: fetchRunArtifactBytes,
  slotBase: (run) => slotBase?.(run),
});
function syncContentPrefetch(): void {
  contentPrefetch.sync(owner.cache, owner.cache !== undefined && owner.cache === persistentCache);
}
owner.subscribe(() => {
  syncContentPrefetch();
  notify();
});

function sync(): void {
  if (suspended) return;
  owner.update({ client: gateway, connection: connectionInputs() });
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
/** Pending gates and active runs, from the shared observations; nothing polls. */
export function setContentPrefetchTargets(
  targets: readonly ContentPrefetchTarget[],
  base?: (run: Run) => string | undefined,
): void {
  slotBase = base;
  contentPrefetch.setTargets(targets);
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
