import {
  createGatewayResourceCache,
  createResourceCacheTransport,
  type GatewayResourceCache,
  type ResourceClientConnection,
  type ResourceConnectionInputs,
  type ResourceConnectionReason,
  type ResourceStore,
  type ResourceStoreIdentity,
  type ResourceStoreMetadata,
  resourceStoreScopeId,
  sameResourceAuthority,
} from '@farmslot/protocol/client-cache';

import { parseResourceStoreIdentity, resourceIdentityFromConnection } from './identity.js';

export interface ResourceIdentityStorage {
  load(): Promise<string | null>;
  save(identity: ResourceStoreIdentity | undefined): Promise<void>;
}

export interface StoredResourceCacheOptions {
  contentBudgetBytes?: number;
  client: ResourceClientConnection;
  snapshot(): ResourceConnectionInputs;
  identities: ResourceIdentityStorage;
  openStore(metadata: ResourceStoreMetadata): Promise<ResourceStore>;
  onNotice?(notice: string | undefined): void;
  /** Previously verified scope for offline rendering only, never command authorization. */
  onIdentity?(identity: ResourceStoreIdentity | undefined): void;
}

const revocations = new Set<ResourceConnectionReason>([
  'sign-out',
  'principal-change',
  'credential-refused',
  'session-ended',
]);

/** Platform owners provide storage; queries, reads and invalidation stay in the protocol cache. */
export function createStoredResourceCache(
  options: StoredResourceCacheOptions,
): GatewayResourceCache {
  const initial = options.snapshot();
  if (!initial.gatewayUrl) throw new Error('Select a gateway before opening a resource cache');
  let remembered: ResourceStoreIdentity | undefined;
  let volatileIdentity: ResourceStoreIdentity | undefined;
  let identityVersion = 0;
  let revoked = false;
  let disposed = false;
  let writeTail: Promise<void> = Promise.resolve();
  let identityFailure: Error | undefined;
  const deletedIdentities = new Map<string, ResourceStoreIdentity>();
  const metadataListeners = new Set<() => void>();
  const load = options.identities.load();
  const loadVersion = identityVersion;
  const client = options.client;
  const transport = createResourceCacheTransport(
    {
      get resourceConnectionReason() {
        return client.resourceConnectionReason;
      },
      requestResource: (method, params, signal) => client.requestResource(method, params, signal),
      subscribe: (event, listener) => client.subscribe(event, listener),
      reconnect: () => client.reconnect(),
      onConnectionChange(listener) {
        metadataListeners.add(listener);
        const stop = client.onConnectionChange(listener);
        return () => {
          metadataListeners.delete(listener);
          stop();
        };
      },
    },
    () => ({ ...options.snapshot(), lastVerified: remembered ?? volatileIdentity }),
  );

  function save(identity: ResourceStoreIdentity | undefined): void {
    const job = writeTail.then(async () => {
      await load;
      await options.identities.save(identity);
      identityFailure = undefined;
    });
    // Failed identity metadata is recoverable: the live session works, but offline startup is not promised.
    writeTail = job.then(
      () => undefined,
      (error: unknown) => {
        identityFailure = error instanceof Error ? error : new Error(String(error));
        if (!disposed)
          options.onNotice?.(
            `Offline startup could not be remembered: ${error instanceof Error ? error.message : String(error)}`,
          );
      },
    );
  }

  function rememberCurrent(): void {
    if (disposed) return;
    const state = options.snapshot();
    const reason = state.reason ?? client.resourceConnectionReason;
    if (reason && revocations.has(reason)) {
      if (remembered)
        deletedIdentities.set(resourceStoreScopeId(remembered.metadata.scope), remembered);
      revoked = true;
      remembered = undefined;
      volatileIdentity = undefined;
      identityVersion++;
      save(undefined);
    } else if (state.connected && state.authentication) {
      const connection = transport.getConnection();
      remembered = resourceIdentityFromConnection(connection);
      // A verified legacy scope still owns its memory data through a network outage.
      // Only the complete identity above is written for persistent cold startup.
      volatileIdentity = connection.authority
        ? {
            authMode: connection.authMode,
            metadata: { scope: connection.scope, authority: connection.authority },
          }
        : undefined;
      identityVersion++;
      save(remembered);
    }
    options.onIdentity?.(remembered);
  }
  // Identity bookkeeping runs before the cache receives the socket's authority notification.
  const stopIdentity = client.onConnectionChange(rememberCurrent);
  rememberCurrent();

  const identityReady = load.then(async (raw) => {
    const saved = parseResourceStoreIdentity(raw, initial.gatewayUrl, initial.profileId);
    const current = resourceIdentityFromConnection(transport.getConnection());
    if (
      saved &&
      (revoked ||
        (options.snapshot().connected &&
          (!current ||
            resourceStoreScopeId(current.metadata.scope) !==
              resourceStoreScopeId(saved.metadata.scope) ||
            !sameResourceAuthority(current.metadata.authority, saved.metadata.authority))))
    ) {
      deletedIdentities.set(resourceStoreScopeId(saved.metadata.scope), saved);
    }
    for (const previous of deletedIdentities.values()) {
      const old = await options.openStore(previous.metadata);
      try {
        await old.deleteAll();
      } finally {
        await old.close();
      }
    }
    if (disposed) return;
    if (identityVersion === loadVersion) remembered = saved;
    options.onIdentity?.(remembered);
    for (const listener of metadataListeners) listener();
  });
  // Keep the rejected readiness promise for openStore; also show failure when no query is observed yet.
  void identityReady.catch((error: unknown) => {
    if (!disposed)
      options.onNotice?.(
        `Offline storage could not be opened: ${error instanceof Error ? error.message : String(error)}`,
      );
  });
  const cache = createGatewayResourceCache({
    contentBudgetBytes: options.contentBudgetBytes,
    transport,
    openStore: async (metadata) => {
      await identityReady;
      if (disposed) throw new Error('Resource cache session closed');
      return options.openStore(metadata);
    },
    onStorageNotice: (notice) => {
      if (!disposed) options.onNotice?.(notice);
    },
  });
  return {
    ...cache,
    async dispose(reason) {
      if (disposed) return;
      if (reason && revocations.has(reason)) {
        revoked = true;
        if (remembered)
          deletedIdentities.set(resourceStoreScopeId(remembered.metadata.scope), remembered);
        remembered = undefined;
        volatileIdentity = undefined;
        save(undefined);
      }
      options.onIdentity?.(undefined);
      disposed = true;
      stopIdentity();
      await Promise.all([cache.dispose(reason), identityReady, writeTail]);
      if (identityFailure) throw identityFailure;
    },
  };
}
