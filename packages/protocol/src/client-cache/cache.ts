import type { ResourceChangedPayload } from '../transport/events.js';

import { resourceKeyId, type ResourceReadStamp } from './keys.js';
import type { ResourceQuery } from './registry.js';
import {
  createMemoryResourceStore,
  normalizeResourceStoreScope,
  type ResourceStoreMetadata,
  resourceStoreScopeId,
  sameResourceAuthority,
} from './store.js';
import type {
  GatewayResourceCache,
  GatewayResourceCacheOptions,
  ResourceCacheConnection,
  ResourceConnectionReason,
  ResourceQueryError,
  ResourceQueryState,
} from './types.js';

interface PendingRead {
  version: number;
  serial: number;
  controller: AbortController;
  promise: Promise<void>;
}
interface QueryEntry {
  query: ResourceQuery;
  state: ResourceQueryState;
  listeners: Set<(state: ResourceQueryState) => void>;
  hydration: Promise<void>;
  hydrated: boolean;
  hydrationSerial: number;
  queued: boolean;
  serial: number;
  unknownGeneration: number;
  lastUsed: number;
  pending?: PendingRead;
  dirty: boolean;
}

const deletionReasons = new Set<ResourceConnectionReason>([
  'sign-out',
  'principal-change',
  'credential-refused',
  'session-ended',
]);
const evictionCodes = new Set([
  'AUTH_FORBIDDEN',
  'AUTH_REQUIRED',
  'NOT_FOUND',
  'RUN_NOT_FOUND',
  'RESOURCE_NOT_FOUND',
]);

function queryError(error: unknown): ResourceQueryError {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return {
    code: typeof code === 'string' ? code : 'READ_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

function canPersist(connection: ResourceCacheConnection): boolean {
  return (
    connection.authMode === 'none' ||
    (typeof connection.scope.principalId === 'string' &&
      Number.isSafeInteger(connection.scope.principalGeneration) &&
      connection.scope.principalGeneration! >= 0)
  );
}

function normalizeConnection(connection: ResourceCacheConnection): ResourceCacheConnection {
  const scope = normalizeResourceStoreScope(connection.scope);
  return {
    ...connection,
    scope:
      connection.authMode === 'none'
        ? { gatewayUrl: scope.gatewayUrl, profileId: scope.profileId }
        : scope,
  };
}

function profileId(connection: ResourceCacheConnection): string {
  return resourceStoreScopeId({
    gatewayUrl: connection.scope.gatewayUrl,
    profileId: connection.scope.profileId,
  });
}

/** Experimental ADR-071 controller. It opens no sockets and never accepts a command. */
export function createGatewayResourceCache(
  options: GatewayResourceCacheOptions,
): GatewayResourceCache {
  const transport = options.transport;
  let store = options.store ?? createMemoryResourceStore();
  let metadata: ResourceStoreMetadata | undefined;
  let connection = normalizeConnection(transport.getConnection());
  let usable = false;
  let disposed = false;
  let version = 0;
  let storeVersion = 0;
  let lastUsed = 0;
  let storageNotice: string | undefined;
  let needsStore = options.store === undefined && options.openStore !== undefined;
  let deletionRequired = false;
  let barrier: Promise<void> = Promise.resolve();
  const entries = new Map<string, QueryEntry>();
  const revisions = new Map<string, number>();
  const encoder = new TextEncoder();
  let retiringStore = false;
  let unsubscribeStore = store.onDeleted(storeDeleted);

  function storeDeleted(): void {
    if (disposed || retiringStore) return;
    usable = false;
    version++;
    for (const entry of entries.values()) invalidate(entry, true);
    transport.resynchronize();
  }

  function replaceStore(next: typeof store): void {
    unsubscribeStore();
    store = next;
    storeVersion++;
    unsubscribeStore = store.onDeleted(storeDeleted);
  }

  function notify(entry: QueryEntry): void {
    entry.state = { ...entry.state, storageNotice };
    for (const listener of entry.listeners) listener(entry.state);
  }

  function invalidate(entry: QueryEntry, clear = false): void {
    entry.serial++;
    entry.pending?.controller.abort();
    entry.pending = undefined;
    entry.dirty = true;
    entry.state = clear
      ? { status: 'loading' }
      : { ...entry.state, status: 'stale', error: undefined };
    notify(entry);
  }

  function prune(): void {
    const inactive = [...entries.values()]
      .filter((entry) => !entry.listeners.size && !entry.pending && entry.hydrated)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (inactive.length > (options.maxInactiveEntries ?? 100)) {
      const entry = inactive.shift()!;
      entry.serial++;
      entries.delete(entry.query.id);
      if (!store.persistent) {
        const memory = store;
        void memory
          .deleteQuery(entry.query.id)
          .catch((error: unknown) => recoverStore(error, memory));
      }
    }
  }

  async function recoverStore(error: unknown, failed = store): Promise<void> {
    // A retired store's late I/O failure cannot replace the new principal's store.
    if (failed !== store || disposed) return;
    replaceStore(createMemoryResourceStore());
    storageNotice = `Cached data will not survive a restart: ${queryError(error).message}`;
    if (metadata) await store.setMetadata(metadata);
    try {
      await failed.close();
    } catch (closeError) {
      // Data stays in memory; retain both failures in the visible storage notice.
      storageNotice += `; ${queryError(closeError).message}`;
    }
    options.onStorageNotice?.(storageNotice);
    for (const entry of entries.values()) notify(entry);
  }

  async function openFreshStore(
    next: ResourceStoreMetadata,
    nextConnection: ResourceCacheConnection,
  ): Promise<void> {
    metadata = next;
    try {
      replaceStore(
        options.openStore && canPersist(nextConnection)
          ? await options.openStore(next)
          : createMemoryResourceStore(),
      );
      const stored = await store.getMetadata();
      if (
        stored &&
        (resourceStoreScopeId(stored.scope) !== resourceStoreScopeId(next.scope) ||
          !sameResourceAuthority(stored.authority, next.authority))
      ) {
        retiringStore = true;
        try {
          await store.deleteAll();
        } finally {
          retiringStore = false;
        }
        await store.close();
        replaceStore(
          options.openStore && canPersist(nextConnection)
            ? await options.openStore(next)
            : createMemoryResourceStore(),
        );
      }
      if (store.persistent) {
        storageNotice = undefined;
        options.onStorageNotice?.(undefined);
      } else if (options.openStore && !canPersist(nextConnection)) {
        storageNotice = 'Offline data will not survive a restart with this gateway version.';
        options.onStorageNotice?.(storageNotice);
      }
    } catch (error) {
      await recoverStore(error);
    }
    needsStore = false;
    for (const entry of entries.values()) if (entry.state.status !== 'ready') hydrateEntry(entry);
  }

  function schedule(entry: QueryEntry): void {
    if (entry.queued || disposed) return;
    entry.queued = true;
    queueMicrotask(() => {
      entry.queued = false;
      if (entry.listeners.size && usable && !disposed) void fetchEntry(entry, true);
    });
  }

  function changedConnection(
    input: ResourceCacheConnection,
    reason?: ResourceConnectionReason,
  ): void {
    if (disposed) return;
    const next = normalizeConnection(input);
    const revoke = reason !== undefined && deletionReasons.has(reason);
    const previousScope = connection.connected
      ? connection.scope
      : (metadata?.scope ?? connection.scope);
    const previousAuthority = connection.authority ?? metadata?.authority;
    const scopeChanged = resourceStoreScopeId(previousScope) !== resourceStoreScopeId(next.scope);
    const authorityChanged = Boolean(
      previousAuthority &&
      next.authority &&
      !sameResourceAuthority(previousAuthority, next.authority),
    );
    if (
      usable &&
      next.connected &&
      next.foreground !== false &&
      connection.id === next.id &&
      !scopeChanged &&
      !authorityChanged &&
      !revoke
    )
      return;
    const ticket = ++version;
    connection = next;
    usable = false;
    revisions.clear();
    for (const entry of entries.values())
      invalidate(entry, revoke || scopeChanged || authorityChanged);
    barrier = barrier
      .then(async () => {
        // Process every authority transition in order, even if a newer connect is queued.
        // In particular, reconnect must never skip an earlier sign-out deletion.
        if (!metadata) {
          try {
            metadata = await store.getMetadata();
          } catch (error) {
            await recoverStore(error);
          }
        }
        const nextMetadata = next.authority
          ? { scope: next.scope, authority: next.authority }
          : undefined;
        const storedScopeChanged =
          metadata && resourceStoreScopeId(metadata.scope) !== resourceStoreScopeId(next.scope);
        const storedAuthorityChanged =
          metadata && next.authority && !sameResourceAuthority(metadata.authority, next.authority);
        const previousProfile = metadata
          ? resourceStoreScopeId({
              gatewayUrl: metadata.scope.gatewayUrl,
              profileId: metadata.scope.profileId,
            })
          : undefined;
        const switchingProfile =
          !revoke && previousProfile !== undefined && previousProfile !== profileId(next);
        if (
          revoke ||
          deletionRequired ||
          store.deleted ||
          switchingProfile ||
          ((next.connected || next.authority !== undefined) &&
            (storedScopeChanged || storedAuthorityChanged))
        ) {
          storeVersion++;
          for (const entry of entries.values()) invalidate(entry, true);
          // Switching profiles retains the old profile's store; revoked authority deletes it.
          if (!switchingProfile || revoke || deletionRequired) {
            deletionRequired = true;
            retiringStore = true;
            try {
              await store.deleteAll();
            } finally {
              retiringStore = false;
            }
            deletionRequired = false;
          }
          await store.close();
          replaceStore(createMemoryResourceStore());
          metadata = undefined;
          needsStore = true;
        }
        if (next.connected && store.persistent && !canPersist(next)) {
          await store.close();
          replaceStore(createMemoryResourceStore());
          for (const entry of entries.values()) invalidate(entry, true);
        }
        if (nextMetadata && !revoke) {
          if (needsStore && (next.connected || canPersist(next)))
            await openFreshStore(nextMetadata, next);
          if (next.connected) {
            metadata = nextMetadata;
            try {
              await store.setMetadata(metadata);
            } catch (error) {
              await recoverStore(error);
            }
          }
        }
        if (disposed || ticket !== version) return;
        usable = next.connected && next.foreground !== false && !revoke;
        if (usable) for (const entry of entries.values()) schedule(entry);
      })
      .catch((error: unknown) => {
        // An authority deletion failure must not admit reads or render the old principal's data.
        usable = false;
        for (const entry of entries.values()) {
          entry.state = {
            status: 'error',
            error: { ...queryError(error), code: 'STORE_SCOPE_FAILED' },
          };
          notify(entry);
        }
      });
  }

  function changedResources(payload: ResourceChangedPayload): void {
    if (disposed || !usable) return;
    const epoch = connection.capabilities?.resourceChanges?.epoch;
    if (payload.version !== 1 || payload.epoch !== epoch) {
      usable = false;
      version++;
      for (const entry of entries.values()) invalidate(entry);
      transport.resynchronize();
      return;
    }
    for (const change of payload.changes) {
      if (!Number.isSafeInteger(change.revision) || change.revision < 0) {
        usable = false;
        for (const entry of entries.values()) invalidate(entry);
        transport.resynchronize();
        return;
      }
      const id = resourceKeyId(change.key);
      if (change.revision <= (revisions.get(id) ?? -1)) continue;
      revisions.set(id, change.revision);
      const affected = [...entries.values()].filter((entry) =>
        entry.query.dependencies.some((key) => resourceKeyId(key) === id),
      );
      const targets = affected.length ? affected : [...entries.values()];
      for (const entry of targets) {
        if (!affected.length) entry.unknownGeneration++;
        entry.dirty = true;
        entry.state = { ...entry.state, status: 'stale', error: undefined };
        notify(entry);
        if (!entry.pending) schedule(entry);
      }
    }
  }

  // Listen before any metadata hydration or query read can start.
  const unsubscribeChanges = transport.onResourceChanged(changedResources);
  const unsubscribeConnection = transport.onConnectionChange(changedConnection);
  changedConnection(transport.getConnection());

  function entryFor(query: ResourceQuery): QueryEntry {
    const existing = entries.get(query.id);
    if (existing) {
      existing.lastUsed = ++lastUsed;
      return existing;
    }
    const entry: QueryEntry = {
      query,
      state: { status: 'loading' },
      listeners: new Set(),
      hydration: Promise.resolve(),
      hydrated: false,
      hydrationSerial: 0,
      queued: false,
      serial: 0,
      unknownGeneration: 0,
      lastUsed: ++lastUsed,
      dirty: true,
    };
    entries.set(query.id, entry);
    hydrateEntry(entry);
    return entry;
  }

  function hydrateEntry(entry: QueryEntry): void {
    const query = entry.query;
    const hydrationSerial = ++entry.hydrationSerial;
    entry.hydrated = false;
    entry.hydration = (async () => {
      await barrier;
      if (disposed || entry.hydrationSerial !== hydrationSerial || entries.get(query.id) !== entry)
        return;
      const ticket = version;
      const incarnation = storeVersion;
      const readingStore = store;
      try {
        const saved = query.persisted ? await readingStore.getQuery(query.id) : undefined;
        if (
          !disposed &&
          !readingStore.deleted &&
          entries.get(query.id) === entry &&
          ticket === version &&
          incarnation === storeVersion &&
          entry.hydrationSerial === hydrationSerial &&
          entry.state.status !== 'ready' &&
          saved &&
          saved.bytes <= query.maxBytes
        ) {
          entry.state = { status: 'stale', data: saved.data, observedAt: saved.observedAt };
          notify(entry);
        }
      } catch (error) {
        await recoverStore(error, readingStore);
      } finally {
        if (entry.hydrationSerial === hydrationSerial) {
          entry.hydrated = true;
          prune();
        }
      }
    })();
  }

  function stampCovers(entry: QueryEntry, stamp: ResourceReadStamp | undefined): boolean {
    if (
      !stamp ||
      !Array.isArray(stamp.dependencies) ||
      stamp.epoch !== connection.capabilities?.resourceChanges?.epoch
    )
      return false;
    return entry.query.dependencies.every((key) => {
      const id = resourceKeyId(key);
      const covered = stamp.dependencies.find(
        (dependency) => resourceKeyId(dependency.key) === id,
      )?.revision;
      return (
        covered !== undefined &&
        Number.isSafeInteger(covered) &&
        covered >= (revisions.get(id) ?? 0)
      );
    });
  }

  async function fetchEntry(entry: QueryEntry, observedOnly = false): Promise<void> {
    await barrier;
    await entry.hydration;
    if (
      disposed ||
      !usable ||
      entries.get(entry.query.id) !== entry ||
      (observedOnly && !entry.listeners.size)
    )
      return;
    if (entry.pending?.version === version) return entry.pending.promise;
    const pending: PendingRead = {
      version,
      serial: ++entry.serial,
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    entry.pending = pending;
    entry.dirty = false;
    const unknownGeneration = entry.unknownGeneration;
    entry.state = {
      ...entry.state,
      status: entry.state.data === undefined ? 'loading' : 'stale',
      error: undefined,
    };
    notify(entry);
    pending.promise = (async () => {
      try {
        const reply = await transport.request(
          entry.query.method,
          entry.query.params,
          pending.controller.signal,
        );
        if (
          disposed ||
          store.deleted ||
          pending.version !== version ||
          pending.serial !== entry.serial ||
          pending.controller.signal.aborted
        )
          return;
        const writingStore = store;
        const writingIncarnation = storeVersion;
        const supported =
          entry.query.live && connection.capabilities?.resourceChanges?.version === 1;
        const covered =
          supported &&
          stampCovers(entry, reply.resourceState) &&
          entry.unknownGeneration === unknownGeneration;
        entry.state = {
          status: covered ? 'ready' : supported ? 'stale' : 'unsupported',
          data: reply.data,
          observedAt: Date.now(),
          resourceState: reply.resourceState,
          ...(!reply.resourceState && supported
            ? {
                error: {
                  code: 'RESOURCE_STATE_MISSING',
                  message: 'The gateway read supplied no resource revision stamp.',
                },
              }
            : {}),
        };
        // Only a real intervening invalidation needs a follow-up; missing metadata is not a retry loop.
        entry.dirty = supported && !covered && entry.dirty;
        notify(entry);
        if (
          !disposed &&
          pending.version === version &&
          pending.serial === entry.serial &&
          !pending.controller.signal.aborted &&
          writingIncarnation === storeVersion &&
          entry.query.persisted &&
          canPersist(connection)
        ) {
          const bytes = encoder.encode(JSON.stringify(reply.data)).byteLength;
          try {
            if (bytes <= entry.query.maxBytes)
              await writingStore.putQuery({
                id: entry.query.id,
                data: reply.data,
                observedAt: entry.state.observedAt!,
                bytes,
              });
            else await writingStore.deleteQuery(entry.query.id);
          } catch (error) {
            await recoverStore(error, writingStore);
          }
        }
      } catch (error) {
        if (
          disposed ||
          pending.version !== version ||
          pending.serial !== entry.serial ||
          pending.controller.signal.aborted
        )
          return;
        const failure = queryError(error);
        entry.dirty = false;
        if (evictionCodes.has(failure.code)) {
          const evictingStore = store;
          entry.state = { status: 'error', error: failure };
          notify(entry);
          if (
            disposed ||
            pending.version !== version ||
            pending.serial !== entry.serial ||
            pending.controller.signal.aborted
          )
            return;
          try {
            await evictingStore.deleteQuery(entry.query.id);
          } catch (error) {
            await recoverStore(error, evictingStore);
          }
        } else
          entry.state = {
            ...entry.state,
            status: entry.state.data === undefined ? 'error' : 'stale',
            error: failure,
          };
        notify(entry);
      } finally {
        if (entry.pending === pending) {
          entry.pending = undefined;
          if (entry.dirty && entry.listeners.size && usable) schedule(entry);
          prune();
        }
      }
    })();
    return pending.promise;
  }

  return {
    observe<T>(query: ResourceQuery<T>, listener: (state: ResourceQueryState<T>) => void) {
      if (disposed) throw new Error('Resource cache is disposed');
      const entry = entryFor(query);
      const receive = (state: ResourceQueryState) => listener(state as ResourceQueryState<T>);
      entry.listeners.add(receive);
      receive(entry.state);
      if (entry.state.status !== 'ready' || entry.dirty) schedule(entry);
      return () => {
        entry.listeners.delete(receive);
        if (!entry.listeners.size && entry.pending) invalidate(entry);
        entry.lastUsed = ++lastUsed;
        prune();
      };
    },
    read<T>(query: ResourceQuery<T>) {
      if (disposed) throw new Error('Resource cache is disposed');
      return entryFor(query).state as ResourceQueryState<T>;
    },
    async retry<T>(query: ResourceQuery<T>) {
      if (disposed) throw new Error('Resource cache is disposed');
      const entry = entryFor(query);
      await fetchEntry(entry);
      return entry.state as ResourceQueryState<T>;
    },
    async dispose(reason?: ResourceConnectionReason) {
      if (disposed) return;
      disposed = true;
      version++;
      unsubscribeChanges();
      unsubscribeConnection();
      unsubscribeStore();
      for (const entry of entries.values()) {
        entry.serial++;
        entry.pending?.controller.abort();
        entry.listeners.clear();
      }
      entries.clear();
      await barrier;
      if (reason && deletionReasons.has(reason)) await store.deleteAll();
      await store.close();
    },
  };
}
