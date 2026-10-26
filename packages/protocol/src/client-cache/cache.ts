import type { NativeSessionReadResult, NativeSessionTargetParams } from '../rpc/native-session.js';
import { Methods } from '../rpc/registry.js';
import type { ResourceChangedPayload } from '../transport/events.js';

import { ResourceCollectorAdmission } from './collector-admission.js';
import { RESOURCE_PUBLISH_INTERVAL_MS, resourceKeyId, type ResourceReadStamp } from './keys.js';
import {
  nativeHistoryStorageId,
  readNativeHistory,
  storedNativeHistoryMatches,
} from './native-history.js';
import type { ResourceQuery } from './registry.js';
import {
  createMemoryResourceStore,
  normalizeResourceStoreScope,
  type ResourceStore,
  type ResourceStoreMetadata,
  resourceStoreScopeId,
  sameResourceAuthority,
  type StoredResourceQuery,
} from './store.js';
import type {
  GatewayResourceCache,
  GatewayResourceCacheOptions,
  ResourceCacheConnection,
  ResourceConnectionReason,
  ResourceQueryError,
  ResourceQueryState,
} from './types.js';
import { isUpstreamStoredQuery, upstreamRetentionEvictions } from './upstream-retention.js';
import { workspaceRetentionEvictions } from './workspace-retention.js';

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
  lastRequestedAt?: number;
  readTimer?: ReturnType<typeof setTimeout>;
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
  let hydrationOwnerVersion = 0;
  let lastUsed = 0;
  let storageNotice: string | undefined;
  let needsStore = options.store === undefined && options.openStore !== undefined;
  let deletionRequired = false;
  let barrier: Promise<void> = Promise.resolve();
  const entries = new Map<string, QueryEntry>();
  const revisions = new Map<string, number>();
  const encoder = new TextEncoder();
  const collectors = new ResourceCollectorAdmission(transport);
  let retiringStore = false;
  let retentionSweptStore: ResourceStore | undefined;
  let unsubscribeStore = store.onDeleted(storeDeleted);

  function updateCollectors(): void {
    collectors.update(
      { ...connection, foreground: usable && connection.foreground !== false },
      usable
        ? [...entries.values()].filter((entry) => entry.listeners.size).map((entry) => entry.query)
        : [],
    );
  }

  function storeDeleted(): void {
    if (disposed || retiringStore) return;
    usable = false;
    updateCollectors();
    hydrationOwnerVersion++;
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

  function cancelScheduledRead(entry: QueryEntry): void {
    if (entry.readTimer !== undefined) clearTimeout(entry.readTimer);
    entry.readTimer = undefined;
  }

  function invalidate(entry: QueryEntry, clear = false): void {
    cancelScheduledRead(entry);
    if (clear) entry.lastRequestedAt = undefined;
    entry.serial++;
    entry.pending?.controller.abort();
    entry.pending = undefined;
    entry.dirty = true;
    entry.state = clear ? { status: 'loading' } : { ...entry.state, status: 'stale' };
    notify(entry);
  }

  function prune(): void {
    const inactive = [...entries.values()]
      .filter((entry) => !entry.listeners.size && !entry.pending && entry.hydrated)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (inactive.length > (options.maxInactiveEntries ?? 100)) {
      const entry = inactive.shift()!;
      entry.serial++;
      cancelScheduledRead(entry);
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

  /** Retention, writes and lifecycle changes share one ordered store boundary. */
  function updateStore(
    target: ResourceStore,
    current: () => boolean,
    update: () => Promise<void>,
  ): Promise<void> {
    const updating = barrier.then(async () => {
      if (!current()) return;
      try {
        await update();
      } catch (error) {
        await recoverStore(error, target);
      }
    });
    barrier = updating;
    return updating;
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
    // Stored facts belong to an owner, not a socket attempt. Fence a revoked
    // owner's pending I/O synchronously, before queued deletion can run.
    if (revoke || scopeChanged || authorityChanged) hydrationOwnerVersion++;
    connection = next;
    usable = false;
    updateCollectors();
    revisions.clear();
    for (const entry of entries.values()) {
      entry.lastRequestedAt = undefined;
      invalidate(entry, revoke || scopeChanged || authorityChanged);
    }
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
        if (store.persistent && retentionSweptStore !== store) {
          const target = store;
          try {
            for (const id of upstreamRetentionEvictions(await target.listQueries()))
              await target.deleteQuery(id);
            retentionSweptStore = target;
          } catch (error) {
            await recoverStore(error, target);
          }
        }
        if (disposed || ticket !== version) return;
        usable = next.connected && next.foreground !== false && !revoke;
        updateCollectors();
        if (usable) for (const entry of entries.values()) schedule(entry);
      })
      .catch((error: unknown) => {
        // An authority deletion failure must not admit reads or render the old principal's data.
        usable = false;
        updateCollectors();
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
      updateCollectors();
      version++;
      for (const entry of entries.values()) invalidate(entry);
      transport.resynchronize();
      return;
    }
    for (const change of payload.changes) {
      if (!Number.isSafeInteger(change.revision) || change.revision < 0) {
        usable = false;
        updateCollectors();
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
        entry.state = { ...entry.state, status: 'stale' };
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
      const incarnation = storeVersion;
      const ownerVersion = hydrationOwnerVersion;
      const readingStore = store;
      try {
        const saved = query.persisted
          ? await readingStore.getQuery(nativeHistoryStorageId(query))
          : undefined;
        if (
          !disposed &&
          !readingStore.deleted &&
          entries.get(query.id) === entry &&
          incarnation === storeVersion &&
          ownerVersion === hydrationOwnerVersion &&
          entry.hydrationSerial === hydrationSerial &&
          entry.state.status !== 'ready' &&
          saved &&
          saved.bytes <= query.maxBytes &&
          (query.method !== Methods.NATIVE_SESSION_READ ||
            storedNativeHistoryMatches(query.params as NativeSessionTargetParams, saved.data))
        ) {
          const sourceObservation = query.sourceObservation?.(saved.data);
          entry.state = {
            status: 'stale',
            data: saved.data,
            observedAt: saved.observedAt,
            ...(sourceObservation ? { sourceObservation, error: sourceObservation.error } : {}),
          };
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
    if (
      entry.query.requiresWorkspaceRead &&
      connection.capabilities?.resourceChanges?.workspaceReads !== 1
    ) {
      entry.state = {
        ...entry.state,
        status: 'unsupported',
        error: {
          code: 'RESOURCE_OBSERVATION_UNSUPPORTED',
          message: 'This gateway cannot observe mutable workspace sources.',
        },
      };
      entry.dirty = false;
      notify(entry);
      return;
    }
    if (
      entry.query.requiresObservedRead &&
      connection.capabilities?.resourceChanges?.observedReads !== 1
    ) {
      entry.state = {
        ...entry.state,
        status: 'unsupported',
        error: {
          code: 'RESOURCE_OBSERVATION_UNSUPPORTED',
          message: 'This gateway does not verify node observation admission.',
        },
      };
      entry.dirty = false;
      notify(entry);
      return;
    }
    if (entry.pending?.version === version) return entry.pending.promise;
    const interval = entry.query.dependencies.reduce(
      (maximum, key) => Math.max(maximum, RESOURCE_PUBLISH_INTERVAL_MS[key.family] ?? 0),
      0,
    );
    const wait = interval - (performance.now() - (entry.lastRequestedAt ?? -Infinity));
    if (observedOnly && wait > 0) {
      // A slow read's follow-up can finish just before the next producer notice.
      // Coalesce that automatic read too, rather than exceeding the family's bound.
      entry.readTimer ??= setTimeout(() => {
        entry.readTimer = undefined;
        if (entry.dirty || entry.state.status !== 'ready') schedule(entry);
      }, wait);
      return;
    }
    cancelScheduledRead(entry);
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
      // A cold connected retry can show loading; saved data keeps its last
      // failure visible until a successful read replaces that observation.
      error: entry.state.data === undefined ? undefined : entry.state.error,
    };
    notify(entry);
    pending.promise = (async () => {
      try {
        if (disposed || pending.version !== version || pending.controller.signal.aborted) return;
        if (entry.query.collector) {
          await collectors.require(entry.query, !observedOnly);
          if (disposed || pending.version !== version || pending.controller.signal.aborted) return;
        }
        entry.lastRequestedAt = performance.now();
        const reply =
          entry.query.method === Methods.NATIVE_SESSION_READ
            ? await readNativeHistory(
                entry.query.params as NativeSessionTargetParams,
                entry.state.data as NativeSessionReadResult | undefined,
                (params, signal) =>
                  transport.request<NativeSessionReadResult>(
                    Methods.NATIVE_SESSION_READ,
                    params,
                    signal,
                  ),
                pending.controller.signal,
              )
            : await transport.request(
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
          (!entry.query.collector || collectors.has(entry.query)) &&
          entry.unknownGeneration === unknownGeneration;
        const observedAt = Date.now();
        const sourceObservation = entry.query.sourceObservation?.(reply.data);
        if (entry.query.sourceObservation && !sourceObservation)
          throw Object.assign(new Error('The gateway supplied no upstream source observation.'), {
            code: 'RESOURCE_SOURCE_STATE_MISSING',
          });
        if (
          sourceObservation &&
          sourceObservation.observedAt === undefined &&
          entry.state.sourceObservation?.observedAt !== undefined
        )
          throw Object.assign(
            new Error(
              sourceObservation.error?.message ?? 'The gateway has not observed an upstream value.',
            ),
            {
              code: sourceObservation.error?.code ?? 'UPSTREAM_UNOBSERVED',
            },
          );
        entry.state = {
          status: covered
            ? sourceObservation && sourceObservation.status !== 'ready'
              ? 'stale'
              : 'ready'
            : supported
              ? 'stale'
              : 'unsupported',
          data: reply.data,
          observedAt,
          resourceState: reply.resourceState,
          ...(sourceObservation ? { sourceObservation, error: sourceObservation.error } : {}),
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
        entry.lastUsed = ++lastUsed;
        const persistResult = entry.query.persisted && canPersist(connection);
        const serialized = persistResult
          ? JSON.stringify(
              entry.query.persistedData ? entry.query.persistedData(reply.data) : reply.data,
            )
          : undefined;
        const bytes = serialized === undefined ? 0 : encoder.encode(serialized).byteLength;
        const retention = entry.query.retention;
        const saved: StoredResourceQuery | undefined =
          serialized !== undefined &&
          bytes <= entry.query.maxBytes &&
          (!retention || bytes <= retention.maxBytes)
            ? {
                id: nativeHistoryStorageId(entry.query),
                data: JSON.parse(serialized),
                observedAt,
                accessedAt: Date.now(),
                bytes,
              }
            : undefined;
        notify(entry);
        // This reply is already accepted. A transport pause may make it stale
        // without changing its owner or value. Authority changes clear data
        // synchronously; a newer accepted reply replaces its data or timestamp.
        const current = () =>
          !disposed &&
          entries.get(entry.query.id) === entry &&
          entry.state.data === reply.data &&
          entry.state.observedAt === observedAt &&
          writingIncarnation === storeVersion &&
          writingStore === store &&
          !writingStore.deleted;
        if (persistResult && current()) {
          await updateStore(writingStore, current, async () => {
            if (!saved) {
              await writingStore.deleteQuery(nativeHistoryStorageId(entry.query));
              return;
            }
            if (retention?.cohort === 'workspace') {
              const contentBytes = (await writingStore.byteTotals()).content;
              const budget = options.contentBudgetBytes ?? 500 * 1024 * 1024;
              if (!current()) return;
              if (saved.bytes + contentBytes > budget) {
                await writingStore.deleteQuery(saved.id);
                return;
              }
              const victims = workspaceRetentionEvictions(
                entry.query,
                saved,
                await writingStore.listQueries(),
                budget,
                contentBytes,
              );
              if (!current()) return;
              for (const id of victims) {
                await writingStore.deleteQuery(id);
                if (!current()) return;
              }
            } else if (retention) {
              const previous = (await writingStore.listQueries())
                .filter(
                  (value) =>
                    value.id !== saved.id &&
                    (retention.cohort === 'upstream'
                      ? isUpstreamStoredQuery(value.id)
                      : value.id.startsWith(`${entry.query.method}:`)),
                )
                .sort(
                  (a, b) =>
                    a.observedAt - b.observedAt ||
                    (entries.get(a.id)?.lastUsed ?? 0) - (entries.get(b.id)?.lastUsed ?? 0),
                );
              if (!current()) return;
              let count = previous.length + 1;
              let total = previous.reduce((sum, value) => sum + value.bytes, saved.bytes);
              for (const oldest of previous) {
                if (count <= retention.maxEntries && total <= retention.maxBytes) break;
                await writingStore.deleteQuery(oldest.id);
                if (!current()) return;
                count--;
                total -= oldest.bytes;
              }
            }
            if (current()) await writingStore.putQuery(saved);
          });
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
        // An intervening write still needs one read after failed I/O. Terminal
        // refusals retire that work; an unchanged failed source never retries.
        entry.dirty &&=
          !evictionCodes.has(failure.code) && failure.code !== 'RESOURCE_OBSERVATION_UNSUPPORTED';
        if (evictionCodes.has(failure.code)) {
          const evictingStore = store;
          const evictingIncarnation = storeVersion;
          entry.state = { status: 'error', error: failure };
          // Commit an accepted refusal before a listener queues its profile's close.
          const eviction = updateStore(
            evictingStore,
            () =>
              evictingStore === store &&
              evictingIncarnation === storeVersion &&
              !evictingStore.deleted,
            () => evictingStore.deleteQuery(nativeHistoryStorageId(entry.query)),
          );
          notify(entry);
          await eviction;
          if (
            disposed ||
            pending.version !== version ||
            pending.serial !== entry.serial ||
            pending.controller.signal.aborted
          )
            return;
        } else
          entry.state = {
            ...entry.state,
            status:
              failure.code === 'RESOURCE_OBSERVATION_UNSUPPORTED'
                ? 'unsupported'
                : entry.state.data === undefined
                  ? 'error'
                  : 'stale',
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
      updateCollectors();
      if (query.retention?.cohort === 'workspace') {
        const bindingVersion = version;
        const sessionId = connection.id;
        const hydrationVersion = hydrationOwnerVersion;
        const entryQuery = entry.query;
        const accessedAt = Date.now();
        const sameBinding = () =>
          !disposed &&
          connection.id === sessionId &&
          version === bindingVersion &&
          hydrationOwnerVersion === hydrationVersion &&
          entries.get(query.id) === entry &&
          entry.query === entryQuery;
        const touch = async () => {
          // Let cold hydration establish the saved authority before selecting the store to touch.
          await entry.hydration;
          if (!sameBinding()) return;
          const accessedStore = store;
          const incarnation = storeVersion;
          const authority = metadata;
          const current = () =>
            sameBinding() &&
            metadata === authority &&
            store === accessedStore &&
            storeVersion === incarnation &&
            !accessedStore.deleted;
          await updateStore(accessedStore, current, async () => {
            if (current())
              await accessedStore.touchQuery?.(nativeHistoryStorageId(query), accessedAt);
          });
        };
        void touch().catch((error: unknown) => {
          if (!sameBinding()) return;
          storageNotice = `Cache recency could not be saved: ${queryError(error).message}`;
          options.onStorageNotice?.(storageNotice);
          notify(entry);
        });
      }
      receive(entry.state);
      if (entry.state.status !== 'ready' || entry.dirty) schedule(entry);
      return () => {
        entry.listeners.delete(receive);
        updateCollectors();
        if (!entry.listeners.size) {
          cancelScheduledRead(entry);
          if (entry.pending) invalidate(entry);
        }
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
      const withdrawing = collectors.close();
      disposed = true;
      version++;
      unsubscribeChanges();
      unsubscribeConnection();
      unsubscribeStore();
      for (const entry of entries.values()) {
        entry.serial++;
        cancelScheduledRead(entry);
        entry.pending?.controller.abort();
        entry.listeners.clear();
      }
      entries.clear();
      await barrier;
      try {
        if (reason && deletionReasons.has(reason)) await store.deleteAll();
        await withdrawing;
      } finally {
        await store.close();
      }
    },
  };
}
