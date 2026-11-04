import { afterForegroundPaint } from '../performance/paint.js';
import type { NativeSessionReadResult, NativeSessionTargetParams } from '../rpc/native-session.js';
import { Methods } from '../rpc/registry.js';
import type { RunGetResult, RunListParams, RunListResult } from '../rpc/run.js';
import { runListVersion } from '../runs/list-version.js';
import type { ResourceChangedPayload } from '../transport/events.js';

import { ResourceCollectorAdmission } from './collector-admission.js';
import {
  resourceBudgetEvictions,
  resourceContentWithinLimits,
  verifyResourceContent,
  verifyResourceContentInSlices,
} from './content.js';
import {
  isKnownResourceFamily,
  RESOURCE_PUBLISH_INTERVAL_MS,
  RESOURCE_REREAD_INTERVAL_MS,
  RESOURCE_RETRY_MAX_WAIT_MS,
  resourceKeyId,
  type ResourceReadStamp,
} from './keys.js';
import {
  nativeHistoryStorageId,
  readNativeHistory,
  storedNativeHistoryMatches,
} from './native-history.js';
import { type ResourceQuery, resourceQuery, type ResourceReadMethod } from './registry.js';
import { createRunDetailSync, type RunDetailTarget, runDetailTarget } from './run-details.js';
import {
  isRunListCollectionRead,
  RUN_LIST_COLLECTION_ID,
  RunListCollection,
  runListSummaryFlags,
} from './run-list-versions.js';
import {
  type ContentKey,
  createMemoryResourceStore,
  normalizeResourceStoreScope,
  readStoredQueryBatch,
  type ResourceStore,
  type ResourceStoreMetadata,
  resourceStoreScopeId,
  sameResourceAuthority,
  type StoredResourceContent,
  type StoredResourceQuery,
} from './store.js';
import type {
  GatewayResourceCache,
  GatewayResourceCacheOptions,
  ResourceCacheConnection,
  ResourceConnectionReason,
  ResourceContentInput,
  ResourceContentRetain,
  ResourceContentWriteToken,
  ResourceQueryError,
  ResourceQueryPlacement,
  ResourceQueryState,
  ResourceReadResult,
} from './types.js';
import { isUpstreamStoredQuery, upstreamRetentionEvictions } from './upstream-retention.js';
import {
  workspaceRetentionEvictions,
  workspaceRetentionMembership,
} from './workspace-retention.js';

interface PendingRead {
  version: number;
  serial: number;
  controller: AbortController;
  promise: Promise<void>;
  /** Set only while every caller sharing this read is a prefetch. */
  prefetch?: ResourceQueryPlacement;
  /** Another caller joined, so the starting caller's abort no longer cancels the read. */
  shared?: boolean;
}
interface QueryEntry {
  query: ResourceQuery;
  /** Canonical ids of `query.dependencies`, which every change notification is matched against. */
  dependencyIds: ReadonlySet<string>;
  state: ResourceQueryState;
  metricSource?: 'memory' | 'stored' | 'network';
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
  /** Failed reads since the last answer, and the earliest an automatic reread may follow them. */
  failures: number;
  retryAt?: number;
  /** How long after the last read the changes since it may wait; any unpaced key lifts it. */
  rereadFloor?: number;
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

/**
 * The gateway refused the read: the resource is gone or not this principal's. The
 * cache evicts saved data on these; a network failure or timeout is not one.
 */
export function readRefused(error: ResourceQueryError | undefined): boolean {
  return Boolean(error && evictionCodes.has(error.code));
}

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

const defaultContentBudgetBytes = 500 * 1024 * 1024;
const startupQueryBytes = 8 * 1024 * 1024;
// Only the identity crosses the store seam, never a caller's other fields.
const contentKey = ({ kind, id }: ContentKey): ContentKey => ({ kind, id });

function profileId(connection: ResourceCacheConnection): string {
  return resourceStoreScopeId({
    gatewayUrl: connection.scope.gatewayUrl,
    profileId: connection.scope.profileId,
  });
}

/** Experimental ADR-071 controller. It opens no sockets and never accepts a command. */
/** A read's reply; a run list view served from the collection carries the collection's time. */
type ReadReply = ResourceReadResult<unknown> & { incomplete?: boolean; observedAt?: number };

export function createGatewayResourceCache(
  options: GatewayResourceCacheOptions,
): GatewayResourceCache {
  const transport = options.transport;
  const metrics = options.performance ?? transport.performance;
  const readContexts = new WeakMap<AbortSignal, { identity: object; blocking: boolean }>();
  const collectionIdentities = new Map<ResourceReadMethod, object>();
  function request<T>(
    method: ResourceReadMethod,
    params: unknown,
    signal: AbortSignal,
  ): Promise<ResourceReadResult<T>> {
    const context = readContexts.get(signal);
    let identity = context?.identity ?? collectionIdentities.get(method);
    if (!identity) {
      identity = {};
      collectionIdentities.set(method, identity);
    }
    metrics?.reread(method, identity);
    return transport.request<T>(
      method,
      params,
      signal,
      context?.blocking ? 'interactive-read' : 'background-refresh',
    );
  }
  function recordRead(
    entry: QueryEntry,
    source: 'memory' | 'stored' | 'network' | 'unknown',
    blocking: boolean,
  ): void {
    if (!metrics) return;
    const labels = { method: entry.query.method, cache_source: source };
    metrics.increment('farmslot_client_cache_reads_total', labels);
    if (entry.state.status === 'stale')
      metrics.increment('farmslot_client_stale_reads_total', labels);
    if (blocking) metrics.increment('farmslot_client_blocking_reads_total', labels);
    const age =
      entry.state.observedAt === undefined
        ? undefined
        : (Date.now() - entry.state.observedAt) / 1000;
    if (age !== undefined && Number.isFinite(age) && age >= 0)
      metrics.observe('farmslot_client_cache_age_seconds', labels, age);
    else metrics.increment('farmslot_client_unknown_age_total', labels);
  }

  let store = options.store ?? createMemoryResourceStore();
  let metadata: ResourceStoreMetadata | undefined;
  let startupStore: ResourceStore | undefined;
  let startupOwnerVersion = -1;
  const startupQueries = new Map<string, StoredResourceQuery>();
  let connection = normalizeConnection(transport.getConnection());
  let usable = false;
  let disposed = false;
  let version = 0;
  let storeVersion = 0;
  let hydrationOwnerVersion = 0;
  // A bounded working set of the store's aliased bytes, for synchronous cached paint.
  // Eviction and authority changes invalidate it with the durable rows.
  const residentContent = new Map<string, { key: ContentKey; data: Uint8Array }>();
  const residentLimit = Math.min(
    options.contentBudgetBytes ?? defaultContentBudgetBytes,
    8 * 1024 * 1024,
  );
  let residentVersion = 0;
  function forgetResident(key: ContentKey): void {
    residentVersion++;
    for (const [alias, value] of residentContent)
      if (value.key.kind === key.kind && value.key.id === key.id) residentContent.delete(alias);
  }
  async function removeStoredContent(target: ResourceStore, key: ContentKey): Promise<void> {
    forgetResident(key);
    await target.deleteContent(key);
    forgetResident(key);
  }
  function rememberResident(alias: string, key: ContentKey, data: Uint8Array): void {
    residentContent.delete(alias);
    if (data.byteLength > residentLimit) return;
    residentContent.set(alias, { key, data: data.slice() });
    let bytes = [...residentContent.values()].reduce(
      (sum, value) => sum + value.data.byteLength,
      0,
    );
    for (const [old, value] of residentContent) {
      if (bytes <= residentLimit) break;
      residentContent.delete(old);
      bytes -= value.data.byteLength;
    }
  }
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
  // Version lists: one shared run collection answers every run.list view.
  const runList = new RunListCollection({
    request: (params, signal) => request<RunListResult>(Methods.RUN_LIST, params, signal),
    persist: (merge) => {
      const writingStore = store;
      const incarnation = storeVersion;
      if (!writingStore.mergeRows || !canPersist(connection)) return Promise.resolve();
      const current = () =>
        !disposed &&
        writingStore === store &&
        incarnation === storeVersion &&
        !writingStore.deleted;
      return updateStore(writingStore, current, () =>
        writingStore.mergeRows!(RUN_LIST_COLLECTION_ID, merge),
      );
    },
    maxBodyBytes: resourceQuery(Methods.RUN_LIST).maxBytes,
  });
  let runListLoad: { store: ResourceStore; promise: Promise<void> } | undefined;
  const fallbackDetailTargets = new Map<string, RunDetailTarget>();
  const detailSync = createRunDetailSync({
    connection: () => connection,
    list: async () => (await readStoredContent((target) => target.listQueries())) ?? [],
    stored: (runId) =>
      readStoredContent((target) =>
        target.getQuery<RunGetResult>(resourceQuery(Methods.RUN_GET, { runId }).id),
      ),
    touch: async (runId) => {
      const target = store;
      const ownerVersion = hydrationOwnerVersion;
      await updateStore(
        target,
        () => target === store && !target.deleted && ownerVersion === hydrationOwnerVersion,
        () =>
          target.touchQuery?.(resourceQuery(Methods.RUN_GET, { runId }).id, Date.now()) ??
          Promise.resolve(),
      );
    },
    fetch: (runId, maxStoredBytes, signal) =>
      retryQuery<RunGetResult>(
        resourceQuery(Methods.RUN_GET, { runId }),
        { origin: 'prefetch', cohort: 'run', maxStoredBytes },
        signal,
      ),
    onError: (error) =>
      options.onStorageNotice?.(
        `Background run details could not sync: ${queryError(error).message}`,
      ),
  });

  function refreshDetailTargets(): void {
    const versioned = runList.detailTargets();
    detailSync.setTargets(
      store.persistent && usable
        ? runList.held
          ? versioned
          : [...fallbackDetailTargets.values()]
        : [],
    );
  }

  function forgetRunList(): void {
    runList.clear();
    runListLoad = undefined;
    fallbackDetailTargets.clear();
    detailSync.reset();
  }

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
    residentContent.clear();
    hydrationOwnerVersion++;
    version++;
    forgetRunList();
    for (const entry of entries.values()) invalidate(entry, true);
    transport.resynchronize();
  }

  function replaceStore(next: typeof store): void {
    unsubscribeStore();
    residentContent.clear();
    store = next;
    storeVersion++;
    startupStore = undefined;
    startupQueries.clear();
    detailSync.reset();
    unsubscribeStore = store.onDeleted(storeDeleted);
  }

  /** Observers whose failure was already logged, so a repeating one is reported once. */
  const failedObservers = new WeakSet<(state: ResourceQueryState) => void>();

  /** One observer's failure is its own: the other observers and the cache's reads go on. */
  function deliver(entry: QueryEntry, listener: (state: ResourceQueryState) => void): void {
    try {
      listener(entry.state);
    } catch (error) {
      if (failedObservers.has(listener)) return;
      failedObservers.add(listener);
      console.error(`Resource cache observer of ${entry.query.id} failed:`, error);
    }
  }

  function notify(entry: QueryEntry): void {
    entry.state = { ...entry.state, storageNotice };
    for (const listener of entry.listeners) deliver(entry, listener);
  }

  function cancelScheduledRead(entry: QueryEntry): void {
    if (entry.readTimer !== undefined) clearTimeout(entry.readTimer);
    entry.readTimer = undefined;
  }

  function invalidate(entry: QueryEntry, clear = false): void {
    cancelScheduledRead(entry);
    entry.rereadFloor = undefined;
    if (clear) {
      entry.lastRequestedAt = undefined;
      entry.retryAt = undefined;
    }
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

  function withStoreWriteLock<T>(target: ResourceStore, write: () => Promise<T>): Promise<T> {
    return target.withWriteLock ? target.withWriteLock(write) : write();
  }

  /** Retention, writes and lifecycle changes share one ordered store boundary. */
  function updateStore(
    target: ResourceStore,
    current: () => boolean,
    update: () => Promise<void>,
    lockWrites = true,
  ): Promise<void> {
    const updating = barrier.then(async () => {
      if (!current()) return;
      try {
        const write = async () => {
          // A queued cross-tab write must recheck the owner after acquiring its lock.
          if (current()) await update();
        };
        if (lockWrites) await withStoreWriteLock(target, write);
        else await write();
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

  async function warmStoredQueries(): Promise<void> {
    if (
      !store.persistent ||
      (startupStore === store && startupOwnerVersion === hydrationOwnerVersion)
    )
      return;
    const readingStore = store;
    const incarnation = storeVersion;
    const ownerVersion = hydrationOwnerVersion;
    const current = () =>
      !disposed &&
      store === readingStore &&
      !readingStore.deleted &&
      incarnation === storeVersion &&
      ownerVersion === hydrationOwnerVersion;
    try {
      const batch = await readStoredQueryBatch(readingStore, startupQueryBytes);
      if (!current()) return;
      const collection = batch.find((saved) => saved.id === RUN_LIST_COLLECTION_ID);
      const rows =
        collection && readingStore.getRows
          ? await readingStore.getRows(RUN_LIST_COLLECTION_ID)
          : undefined;
      if (!current()) return;
      startupQueries.clear();
      let remaining = startupQueryBytes;
      for (const saved of batch) {
        if (saved.bytes > remaining) continue;
        remaining -= saved.bytes;
        if (saved.id !== RUN_LIST_COLLECTION_ID) startupQueries.set(saved.id, saved);
      }
      if (rows) runList.hydrate(rows);
      startupStore = readingStore;
      startupOwnerVersion = ownerVersion;
    } catch (error) {
      await recoverStore(error, readingStore);
    }
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
    ) {
      if (connection.metered !== next.metered) {
        connection = { ...connection, metered: next.metered };
        refreshDetailTargets();
      }
      return;
    }
    const ticket = ++version;
    runList.abort();
    // Stored facts belong to an owner, not a socket attempt. Fence a revoked
    // owner's pending I/O synchronously, before queued deletion can run.
    if (revoke || scopeChanged || authorityChanged) {
      metrics?.resetScope();
      residentContent.clear();
      hydrationOwnerVersion++;
      forgetRunList();
    }
    connection = next;
    usable = false;
    refreshDetailTargets();
    updateCollectors();
    revisions.clear();
    for (const entry of entries.values()) {
      entry.lastRequestedAt = undefined;
      entry.retryAt = undefined;
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
          residentContent.clear();
          storeVersion++;
          forgetRunList();
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
            await withStoreWriteLock(target, async () => {
              for (const id of upstreamRetentionEvictions(await target.listQueries()))
                await target.deleteQuery(id);
              retentionSweptStore = target;
            });
          } catch (error) {
            await recoverStore(error, target);
          }
        }
        if (disposed || ticket !== version) return;
        if (!revoke && canPersist(next)) await warmStoredQueries();
        if (disposed || ticket !== version) return;
        usable = next.connected && next.foreground !== false && !revoke;
        refreshDetailTargets();
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
      runList.abort();
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
      const affected = [...entries.values()].filter((entry) => entry.dependencyIds.has(id));
      // Coverage counts declared dependencies only, so a known key that no entry declares (another
      // slot, an unopened workspace) changes nothing held. Only a family this client cannot name might.
      if (!affected.length && isKnownResourceFamily(change.key?.family)) continue;
      const targets = affected.length ? affected : [...entries.values()];
      for (const entry of targets) {
        if (!affected.length) entry.unknownGeneration++;
        const floor =
          entry.query.rereadIntervalMs?.[change.key.family] ??
          RESOURCE_REREAD_INTERVAL_MS[change.key.family];
        entry.rereadFloor = Math.min(
          entry.rereadFloor ?? Infinity,
          (affected.length && floor) || 0,
        );
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
      dependencyIds: new Set(query.dependencies.map(resourceKeyId)),
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
      failures: 0,
    };
    entries.set(query.id, entry);
    const saved = isRunListView(query) ? heldRunListView(query) : takeStartupQuery(query);
    if (applyStoredQuery(entry, saved, 'memory')) {
      entry.hydrated = true;
      queueMicrotask(prune);
    } else hydrateEntry(entry);
    return entry;
  }

  function takeStartupQuery(query: ResourceQuery): StoredResourceQuery | undefined {
    if (startupStore !== store || startupOwnerVersion !== hydrationOwnerVersion) return undefined;
    const id = nativeHistoryStorageId(query);
    const saved = startupQueries.get(id);
    startupQueries.delete(id);
    return saved;
  }

  function applyStoredQuery(
    entry: QueryEntry,
    saved: StoredResourceQuery | undefined,
    origin: 'memory' | 'stored' = 'stored',
  ): boolean {
    const query = entry.query;
    if (
      !saved ||
      !query.persisted ||
      saved.bytes > query.maxBytes ||
      (query.method === Methods.NATIVE_SESSION_READ &&
        !storedNativeHistoryMatches(query.params as NativeSessionTargetParams, saved.data))
    )
      return false;
    entry.metricSource = origin;
    const sourceObservation = query.sourceObservation?.(saved.data);
    entry.state = {
      status: 'stale',
      data: saved.data,
      observedAt: saved.observedAt,
      ...(sourceObservation ? { sourceObservation, error: sourceObservation.error } : {}),
    };
    return true;
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
          ? (takeStartupQuery(query) ??
            (isRunListView(query) ? await storedRunListView(query, readingStore) : undefined) ??
            (await readingStore.getQuery(nativeHistoryStorageId(query))))
          : undefined;
        if (
          !disposed &&
          !readingStore.deleted &&
          entries.get(query.id) === entry &&
          incarnation === storeVersion &&
          ownerVersion === hydrationOwnerVersion &&
          entry.hydrationSerial === hydrationSerial &&
          entry.state.status !== 'ready' &&
          applyStoredQuery(entry, saved)
        ) {
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

  function isRunListView(query: ResourceQuery): boolean {
    return query.method === Methods.RUN_LIST && !isRunListCollectionRead(query.params);
  }

  /** A cold start's view, derived from the stored run collection when one is stored. */
  async function storedRunListView(
    query: ResourceQuery,
    readingStore: ResourceStore,
  ): Promise<StoredResourceQuery | undefined> {
    if (!runList.held && readingStore.getRows) {
      if (runListLoad?.store !== readingStore)
        runListLoad = {
          store: readingStore,
          promise: readingStore.getRows(RUN_LIST_COLLECTION_ID).then((stored) => {
            if (store === readingStore && !readingStore.deleted) runList.hydrate(stored);
          }),
        };
      await runListLoad.promise;
    }
    return heldRunListView(query);
  }

  function heldRunListView(query: ResourceQuery): StoredResourceQuery | undefined {
    const data = runList.view(query.params as RunListParams);
    return data && runList.observedAt !== undefined
      ? { id: query.id, data, observedAt: runList.observedAt, bytes: 0 }
      : undefined;
  }

  /** Summary flags every observed view needs, so one versions read serves them all. */
  function runListFlags() {
    const flags: ReturnType<typeof runListSummaryFlags> = {};
    for (const entry of entries.values())
      if (entry.listeners.size && isRunListView(entry.query))
        Object.assign(flags, runListSummaryFlags(entry.query.params as RunListParams));
    return flags;
  }

  /** Version lists rules 3-5: a view of the shared collection after its one shared refresh. */
  async function readRunListView(entry: QueryEntry, signal: AbortSignal): Promise<ReadReply> {
    const params = entry.query.params as RunListParams;
    const flags = runListFlags();
    try {
      // A new view of a current collection needs no read: no runs change since its version reply.
      if (!runList.complete || !runList.serves(flags) || !stampCovers(entry, runList.resourceState))
        await runList.refresh(flags);
    } catch (error) {
      // A refused collection read evicts the stored collection, like every refused read.
      if (evictionCodes.has(queryError(error).code)) {
        const evictingStore = store;
        forgetRunList();
        void updateStore(
          evictingStore,
          () => evictingStore === store && !evictingStore.deleted,
          () => evictingStore.deleteQuery(RUN_LIST_COLLECTION_ID),
          // Queue one-statement refusal evictions before their callers settle.
          false,
        );
      }
      throw error;
    }
    const data = runList.view(params);
    // A view is a projection of the collection, so it was observed when the collection was.
    if (data)
      return {
        data,
        resourceState: runList.resourceState,
        incomplete: !runList.complete,
        observedAt: runList.observedAt,
      };
    // A view whose summaries the version reply cannot answer keeps its own full read.
    return request<RunListResult>(Methods.RUN_LIST, params, signal);
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

  async function fetchEntry(
    entry: QueryEntry,
    observedOnly = false,
    placement?: ResourceQueryPlacement,
    signal?: AbortSignal,
  ): Promise<void> {
    const prefetch = placement?.origin === 'prefetch' ? placement : undefined;
    await barrier;
    if (signal?.aborted) return;
    await entry.hydration;
    if (
      signal?.aborted ||
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
    if (entry.pending?.version === version) {
      entry.pending.shared = true;
      // Any caller that is not a prefetch makes the shared read an opened one.
      const shared = entry.pending.prefetch;
      entry.pending.prefetch =
        shared && prefetch
          ? {
              origin: 'prefetch',
              cohort: shared.cohort === 'gate' ? 'gate' : prefetch.cohort,
              maxStoredBytes: Math.min(
                shared.maxStoredBytes ?? Infinity,
                prefetch.maxStoredBytes ?? Infinity,
              ),
            }
          : undefined;
      return entry.pending.promise;
    }
    // A read already wanted for another reason (an observer, a failed read, an unpaced change) is
    // not held back by slot changes that come after it.
    entry.rereadFloor ??= 0;
    const interval = entry.query.dependencies.reduce(
      (maximum, key) => Math.max(maximum, RESOURCE_PUBLISH_INTERVAL_MS[key.family] ?? 0),
      entry.rereadFloor,
    );
    const wait = Math.max(
      interval - (performance.now() - (entry.lastRequestedAt ?? -Infinity)),
      (entry.retryAt ?? -Infinity) - performance.now(),
    );
    if (observedOnly && wait > 0) {
      // A slow read's follow-up can finish just before the next producer notice.
      // Coalesce that automatic read too, rather than exceeding the family's bound.
      // The wait only shortens until the next read, so the timer follows the latest one.
      cancelScheduledRead(entry);
      entry.readTimer = setTimeout(() => {
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
      prefetch,
    };
    entry.pending = pending;
    const refreshStarted = metrics?.clock();
    const refreshEpoch = metrics?.epoch;
    const blocking = entry.state.data === undefined;
    readContexts.set(pending.controller.signal, { identity: entry, blocking });
    entry.dirty = false;
    entry.rereadFloor = undefined;
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
        const fromRunList =
          isRunListView(entry.query) &&
          connection.capabilities?.resourceChanges?.versionLists === true;
        const reply: ReadReply = fromRunList
          ? await readRunListView(entry, pending.controller.signal)
          : entry.query.method === Methods.NATIVE_SESSION_READ
            ? await readNativeHistory(
                entry.query.params as NativeSessionTargetParams,
                entry.state.data as NativeSessionReadResult | undefined,
                (params, signal) =>
                  request<NativeSessionReadResult>(Methods.NATIVE_SESSION_READ, params, signal),
                pending.controller.signal,
              )
            : await request(entry.query.method, entry.query.params, pending.controller.signal);
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
          entry.unknownGeneration === unknownGeneration &&
          // A view is current only once every listed run is held at its listed version.
          !reply.incomplete;
        const observedAt = reply.observedAt ?? Date.now();
        // `null` is an explicit non-upstream answer: its status follows coverage, with no source time.
        const sourceObservation = entry.query.sourceObservation?.(reply.data);
        if (entry.query.sourceObservation && sourceObservation === undefined)
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
        entry.metricSource = 'network';
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
        entry.failures = 0;
        entry.retryAt = undefined;
        entry.lastUsed = ++lastUsed;
        // Version-list views are derived from the run collection, which is stored on its own.
        const persistResult =
          entry.query.persisted && canPersist(connection) && reply.incomplete === undefined;
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
          (entry.listeners.size > 0 || bytes <= (pending.prefetch?.maxStoredBytes ?? Infinity)) &&
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
        // A snapshot someone observes is opened, whoever started the read.
        const prefetched = entry.listeners.size ? undefined : pending.prefetch;
        if (persistResult && current()) {
          await updateStore(writingStore, current, async () => {
            // Prefetch never removes a row it could not replace, including one the user opened.
            if (!saved) {
              if (!prefetched) await writingStore.deleteQuery(nativeHistoryStorageId(entry.query));
              return;
            }
            let row = saved;
            if (retention?.cohort === 'workspace') {
              const stored = await writingStore.listQueries();
              const previous = stored.find((value) => value.id === saved.id);
              // A prefetch write evicts only what prefetch may evict, even when it refreshes a
              // snapshot the user opened; that row stays opened. Gate outranks run.
              const write: StoredResourceQuery = prefetched
                ? {
                    ...saved,
                    origin: 'prefetch',
                    cohort: previous?.cohort === 'gate' ? 'gate' : (prefetched.cohort ?? 'run'),
                  }
                : saved;
              if (!previous || previous.origin === 'prefetch') row = write;
              const victims = workspaceRetentionEvictions(
                entry.query,
                write,
                stored,
                options.contentBudgetBytes ?? defaultContentBudgetBytes,
                await writingStore.listContent(),
              );
              if (!current()) return;
              if (!victims) {
                if (!prefetched) await writingStore.deleteQuery(saved.id);
                return;
              }
              for (const id of victims.queries) {
                await writingStore.deleteQuery(id);
                if (!current()) return;
              }
              for (const key of victims.content) {
                await removeStoredContent(writingStore, key);
                if (!current()) return;
              }
            } else if (retention) {
              const previous = (await writingStore.listQueries())
                .filter(
                  (value) =>
                    value.id !== saved.id &&
                    // The run collection is bounded by its own body budget, never by its views.
                    value.id !== RUN_LIST_COLLECTION_ID &&
                    (retention.cohort === 'upstream'
                      ? isUpstreamStoredQuery(value.id)
                      : value.id.startsWith(`${entry.query.method}:`)),
                )
                .sort(
                  (a, b) =>
                    (entry.query.method === Methods.RUN_GET
                      ? (a.accessedAt ?? a.observedAt) - (b.accessedAt ?? b.observedAt)
                      : a.observedAt - b.observedAt) ||
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
            if (current()) await writingStore.putQuery(row);
          });
        }
        if (store.persistent && entry.query.method === Methods.RUN_LIST) {
          const listed = reply.data as RunListResult;
          if (Array.isArray(listed.runs)) {
            for (const run of listed.runs)
              fallbackDetailTargets.set(run.id, runDetailTarget(run, runListVersion(run)));
          }
          refreshDetailTargets();
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
        // A gateway too slow to answer may still be working on the read, so asking again at once
        // piles the same work up there. The wait starts at the failed read's length and doubles.
        const failedAt = performance.now();
        entry.retryAt =
          failedAt +
          Math.min(
            (failedAt - (entry.lastRequestedAt ?? failedAt)) * 2 ** entry.failures++,
            RESOURCE_RETRY_MAX_WAIT_MS,
          );
        // An intervening write still needs one read after failed I/O. Terminal
        // refusals retire that work; an unchanged failed source never retries.
        entry.dirty &&=
          !evictionCodes.has(failure.code) && failure.code !== 'RESOURCE_OBSERVATION_UNSUPPORTED';
        // A healthy source can supersede the first page before this reader has an interest.
        // Keep one paced reread even when its change notice could not reach this reader yet.
        entry.dirty ||=
          entry.query.method === Methods.NATIVE_SESSION_READ &&
          failure.code === 'RESOURCE_OBSERVATION_CHANGED';
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
            // Refusals must not wait for another tab's admission lock before enqueueing deletion.
            false,
          );
          notify(entry);
          // An authorization refusal settles its callers in the reply's own task, so a prefetch
          // stops before a store callback can release another read. The eviction is queued.
          if (failure.code === 'AUTH_FORBIDDEN' || failure.code === 'AUTH_REQUIRED') return;
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
        if (metrics && refreshStarted !== undefined && metrics.epoch === refreshEpoch)
          metrics.observe(
            blocking
              ? 'farmslot_client_blocking_refresh_seconds'
              : 'farmslot_client_background_refresh_seconds',
            {
              method: entry.query.method,
              action_class: blocking ? 'interactive-read' : 'background-refresh',
            },
            metrics.clock() - refreshStarted,
          );
        if (entry.pending === pending) {
          entry.pending = undefined;
          if (entry.dirty && entry.listeners.size && usable) schedule(entry);
          prune();
        }
      }
    })();
    if (signal) {
      // A read only this caller wants stops with it: no response is written after the abort.
      const cancel = () => {
        if (entry.pending === pending && !pending.shared && !entry.listeners.size)
          invalidate(entry);
      };
      signal.addEventListener('abort', cancel, { once: true });
      void pending.promise.finally(() => signal.removeEventListener('abort', cancel));
    }
    return pending.promise;
  }

  /** Content reads follow hydration's owner and incarnation fences; offline reads are allowed. */
  async function readStoredContent<T>(
    read: (target: ResourceStore) => Promise<T | undefined>,
    open?: (target: ResourceStore, value: T) => Promise<void>,
  ): Promise<T | undefined> {
    const ownerVersion = hydrationOwnerVersion;
    await barrier;
    const readingStore = store;
    const incarnation = storeVersion;
    const current = () =>
      !disposed &&
      ownerVersion === hydrationOwnerVersion &&
      incarnation === storeVersion &&
      readingStore === store &&
      !readingStore.deleted;
    if (!current()) return undefined;
    const value = await read(readingStore).catch(async (error: unknown) => {
      await recoverStore(error, readingStore);
      return undefined;
    });
    if (value === undefined || !current()) return undefined;
    if (open) await updateStore(readingStore, current, () => open(readingStore, value));
    return current() ? value : undefined;
  }

  async function readContentBytes(
    lookup: (target: ResourceStore) => Promise<StoredResourceContent | undefined>,
    open: boolean,
  ): Promise<Uint8Array | undefined> {
    const saved = await readStoredContent(
      lookup,
      open
        ? (target, { kind, id }) => target.touchContent({ kind, id }, Date.now(), 'opened')
        : undefined,
    );
    return saved?.data;
  }

  async function readAliasedContent(alias: string, open: boolean): Promise<Uint8Array | undefined> {
    const version = residentVersion;
    const owner = hydrationOwnerVersion;
    const incarnation = storeVersion;
    const saved = await readStoredContent(
      (target) => target.getContentByAlias(alias),
      open
        ? (target, { kind, id }) => target.touchContent({ kind, id }, Date.now(), 'opened')
        : undefined,
    );
    if (
      version !== residentVersion ||
      owner !== hydrationOwnerVersion ||
      incarnation !== storeVersion ||
      disposed
    )
      return undefined;
    if (saved) rememberResident(alias, saved, saved.data);
    return saved?.data;
  }

  /** Content writes accept only the current connection's owner, from the token's fetch onward. */
  async function writeContent(
    token: ResourceContentWriteToken | undefined,
    write: (target: ResourceStore, current: () => boolean) => Promise<boolean>,
  ): Promise<boolean> {
    if (disposed || !connection.connected) return false;
    const ownerVersion = token?.ownerVersion ?? hydrationOwnerVersion;
    const connectionId = token?.connectionId ?? connection.id;
    await barrier;
    const writingStore = store;
    const incarnation = token?.storeVersion ?? storeVersion;
    const current = () =>
      !disposed &&
      connection.connected &&
      connection.id === connectionId &&
      ownerVersion === hydrationOwnerVersion &&
      incarnation === storeVersion &&
      writingStore === store &&
      !writingStore.deleted;
    let written = false;
    await updateStore(writingStore, current, async () => {
      written = (await write(writingStore, current)) && current();
    });
    return written;
  }

  function contentWriteToken(): ResourceContentWriteToken {
    return { connectionId: connection.id, ownerVersion: hydrationOwnerVersion, storeVersion };
  }

  /** Stores verified bytes within the caps and the shared budget. */
  async function storeContent(input: ResourceContentInput): Promise<boolean> {
    const key = contentKey(input.key);
    const { data, origin, cohort } = input;
    // Prefetch verifies between frames, so the write still answers to the owner it was asked under.
    const token = input.token ?? contentWriteToken();
    if (!resourceContentWithinLimits(key, data)) return false;
    // Prefetch is background work; content a person opened is on their critical path and
    // verifies at once, as before.
    const verified =
      origin === 'prefetch'
        ? await verifyResourceContentInSlices(key, data, input.untrackedFiles)
        : verifyResourceContent(key, data, input.untrackedFiles);
    if (!verified) return false;
    return writeContent(token, async (target, current) => {
      const accessedAt = Date.now();
      const content = await target.listContent();
      if (content.some((row) => row.kind === key.kind && row.id === key.id)) {
        // The same identity holds the same bytes; keep the stronger origin and cohort.
        if (!current()) return false;
        await target.retainContent(key, accessedAt, { origin, cohort });
      } else {
        const victims = resourceBudgetEvictions(
          { bytes: data.byteLength, origin, cohort },
          content,
          (await target.listQueries()).filter(
            (row) => workspaceRetentionMembership(row.id) !== undefined,
          ),
          options.contentBudgetBytes ?? defaultContentBudgetBytes,
        );
        if (!victims || !current()) return false;
        for (const id of victims.queries) {
          await target.deleteQuery(id);
          if (!current()) return false;
        }
        for (const victim of victims.content) {
          await removeStoredContent(target, victim);
          if (!current()) return false;
        }
        await target.putContent({
          ...key,
          data,
          bytes: data.byteLength,
          origin,
          cohort,
          accessedAt,
        });
      }
      if (input.alias !== undefined && current()) {
        await target.putContentAlias(input.alias, key);
        if (current()) rememberResident(input.alias, key, data);
      }
      return true;
    });
  }

  /** Promotes held content without its bytes, behind the same fences as a store. */
  function retainContent(key: ContentKey, retain: ResourceContentRetain): Promise<boolean> {
    const held = contentKey(key);
    return writeContent(retain.token, async (target, current) => {
      if (!(await target.hasContent(held)) || !current()) return false;
      await target.retainContent(held, Date.now(), {
        origin: retain.origin,
        cohort: retain.cohort,
      });
      return true;
    });
  }

  async function retryQuery<T>(
    query: ResourceQuery<T>,
    placement?: ResourceQueryPlacement,
    signal?: AbortSignal,
  ): Promise<ResourceQueryState<T>> {
    if (disposed) throw new Error('Resource cache is disposed');
    const entry = entryFor(query);
    await fetchEntry(entry, false, placement, signal);
    return entry.state as ResourceQueryState<T>;
  }

  return {
    observedKey(match) {
      for (const entry of entries.values())
        if (entry.listeners.size && entry.query.dependencies.some(match)) return true;
      return false;
    },
    observe<T>(query: ResourceQuery<T>, listener: (state: ResourceQueryState<T>) => void) {
      if (disposed) throw new Error('Resource cache is disposed');
      const started = metrics?.clock();
      const epoch = metrics?.epoch;
      const alreadyHeld = entries.get(query.id)?.state.data !== undefined;
      const entry = entryFor(query);
      const blocking = entry.state.data === undefined;
      let first = true,
        active = true;
      let cancelPaint: (() => void) | undefined;
      const receive = (state: ResourceQueryState) => {
        listener(state as ResourceQueryState<T>);
        if (state.data === undefined) return;
        const source = alreadyHeld ? 'memory' : (entry.metricSource ?? 'unknown');
        recordRead(entry, source, blocking && first);
        if (!first || !metrics || started === undefined) return;
        first = false;
        if (connection.foreground === false) return;
        cancelPaint = (options.afterPaint ?? afterForegroundPaint)(() => {
          if (!active || disposed || metrics.epoch !== epoch || connection.foreground === false)
            return;
          metrics.observe(
            source === 'network'
              ? 'farmslot_client_visible_read_seconds'
              : 'farmslot_client_cached_paint_seconds',
            {
              method: query.method,
              action_class: source === 'network' ? 'interactive-read' : 'cached-paint',
              cache_source: source,
            },
            metrics.clock() - started,
          );
        });
        if (!cancelPaint)
          metrics.increment('farmslot_client_unmeasured_paints_total', { method: query.method });
      };
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
              await accessedStore.touchQuery?.(nativeHistoryStorageId(query), accessedAt, 'opened');
          });
        };
        void touch().catch((error: unknown) => {
          if (!sameBinding()) return;
          storageNotice = `Cache recency could not be saved: ${queryError(error).message}`;
          options.onStorageNotice?.(storageNotice);
          notify(entry);
        });
      }
      deliver(entry, receive);
      if (entry.state.status !== 'ready' || entry.dirty) schedule(entry);
      return () => {
        active = false;
        cancelPaint?.();
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
      const entry = entryFor(query);
      recordRead(entry, 'memory', entry.state.data === undefined);
      return entry.state as ResourceQueryState<T>;
    },
    async readStored<T>(query: ResourceQuery<T>, refresh = true) {
      if (disposed) throw new Error('Resource cache is disposed');
      const ownerVersion = hydrationOwnerVersion;
      await barrier;
      const entry = entryFor(query);
      await entry.hydration;
      if (disposed || ownerVersion !== hydrationOwnerVersion)
        throw new Error('The offline store owner changed');
      // fetchEntry records network refusals in the query state and notifies its readers.
      if (refresh && entry.state.data !== undefined) void fetchEntry(entry);
      return entry.state as ResourceQueryState<T>;
    },
    retry: retryQuery,
    async retryAfterPending<T>(query: ResourceQuery<T>) {
      if (disposed) throw new Error('Resource cache is disposed');
      const entry = entryFor(query);
      await entry.pending?.promise.catch(() => undefined);
      await fetchEntry(entry, false);
      return entry.state as ResourceQueryState<T>;
    },
    async hasContent(key) {
      return (await readStoredContent((target) => target.hasContent(contentKey(key)))) ?? false;
    },
    readContent: (key) => readContentBytes((target) => target.getContent(contentKey(key)), false),
    runListProjections: () => runList.projections(),
    openContent: (key) => readContentBytes((target) => target.getContent(contentKey(key)), true),
    async forgetContent(key) {
      forgetResident(key);
      const target = store;
      const ownerVersion = hydrationOwnerVersion;
      await updateStore(
        target,
        () => target === store && !target.deleted && ownerVersion === hydrationOwnerVersion,
        () => removeStoredContent(target, contentKey(key)),
      );
    },
    peekContentByAlias: (alias) => residentContent.get(alias)?.data.slice(),
    readContentByAlias: (alias) => readAliasedContent(alias, false),
    openContentByAlias: (alias) => readAliasedContent(alias, true),
    storeContent,
    retainContent,
    contentWriteToken,
    async dispose(reason?: ResourceConnectionReason) {
      if (reason && reason !== 'network' && reason !== 'background' && reason !== 'token-refresh')
        metrics?.resetScope();
      if (disposed) return;
      const withdrawing = collectors.close();
      disposed = true;
      residentContent.clear();
      detailSync.reset();
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
