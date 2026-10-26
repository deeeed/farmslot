import type { ReviewDiffSnapshot } from '../contracts/runs.js';
import type { GatewayAuthConnectResult, GatewayAuthMode } from '../rpc/auth.js';
import type {
  ResourceObserversReplaceParams,
  ResourceObserversReplaceResult,
  UpstreamObservation,
} from '../rpc/resource-observers.js';
import type { ResourceChangedPayload } from '../transport/events.js';

import type { ResourceReadStamp } from './keys.js';
import type { ResourceQuery, ResourceReadMethod } from './registry.js';
import type {
  ContentKey,
  ResourceContentCohort,
  ResourceContentOrigin,
  ResourceContentPlacement,
  ResourceStore,
  ResourceStoreAuthority,
  ResourceStoreMetadata,
  ResourceStoreScope,
} from './store.js';

export type ResourceQueryStatus = 'loading' | 'ready' | 'stale' | 'error' | 'unsupported';
export interface ResourceQueryError {
  code: string;
  message: string;
}
export interface ResourceQueryState<T = unknown> {
  status: ResourceQueryStatus;
  data?: T;
  observedAt?: number;
  sourceObservation?: UpstreamObservation;
  resourceState?: ResourceReadStamp;
  error?: ResourceQueryError;
  storageNotice?: string;
}

export interface ResourceReadResult<T> {
  data: T;
  resourceState?: ResourceReadStamp;
}
export interface ResourceReadOptions {
  signal?: AbortSignal;
  includeResourceState?: boolean;
}
export interface ResourceCacheConnection {
  /** Transport connection identity, not the gateway epoch. Token refresh retains it. */
  id: number | string;
  connected: boolean;
  foreground?: boolean;
  authMode: GatewayAuthMode;
  scope: ResourceStoreScope;
  authority?: ResourceStoreAuthority;
  capabilities?: GatewayAuthConnectResult['capabilities'];
}

export type ResourceConnectionReason =
  | 'network'
  | 'background'
  | 'access-token-expired'
  | 'token-refresh'
  | 'sign-out'
  | 'principal-change'
  | 'credential-refused'
  | 'session-ended'
  | 'profile-change';

export interface ResourceCacheTransport {
  getConnection(): ResourceCacheConnection;
  onConnectionChange(
    listener: (connection: ResourceCacheConnection, reason?: ResourceConnectionReason) => void,
  ): () => void;
  onResourceChanged(listener: (payload: ResourceChangedPayload) => void): () => void;
  request<T>(
    method: ResourceReadMethod,
    params: unknown,
    signal: AbortSignal,
  ): Promise<ResourceReadResult<T>>;
  replaceObservers?(
    params: ResourceObserversReplaceParams,
    signal: AbortSignal,
  ): Promise<ResourceObserversReplaceResult>;
  /** A changed epoch or broken change feed requires the transport's normal reconnect path. */
  resynchronize(): void;
}

export interface GatewayResourceCacheOptions {
  onStorageNotice?: (notice: string | undefined) => void;
  transport: ResourceCacheTransport;
  store?: ResourceStore;
  /** Reopens a fresh scoped incarnation after authority deletion or a profile switch. */
  openStore?: (metadata: ResourceStoreMetadata) => Promise<ResourceStore>;
  maxInactiveEntries?: number;
  /** Shared workspace/content budget supplied once by the platform owner. */
  contentBudgetBytes?: number;
}

/** Opaque: the connection, owner and store incarnation a content read started under. */
export interface ResourceContentWriteToken {
  readonly connectionId: number | string;
  readonly ownerVersion: number;
  readonly storeVersion: number;
}

export interface ResourceContentInput {
  key: ContentKey;
  data: Uint8Array;
  origin: ResourceContentOrigin;
  cohort: ResourceContentCohort;
  /** A diff's untracked-file manifest, which its `diffHash` fingerprints. */
  untrackedFiles?: ReviewDiffSnapshot['untrackedFiles'];
  /** Captured before the fetch; the write is refused if any part has changed since. */
  token?: ResourceContentWriteToken;
  /** Also finds the content by this name, such as a frozen review diff; the latest store wins. */
  alias?: string;
}

export interface ResourceContentRetain extends ResourceContentPlacement {
  token?: ResourceContentWriteToken;
}

export interface GatewayResourceCache {
  observe<T>(query: ResourceQuery<T>, listener: (state: ResourceQueryState<T>) => void): () => void;
  read<T>(query: ResourceQuery<T>): ResourceQueryState<T>;
  /**
   * A `prefetch` placement persists a workspace snapshot as prefetched content: it counts toward
   * the prefetch half of the budget and evicts only what prefetch may evict. A later read the user
   * observes, or a read without a placement, keeps it as opened.
   */
  retry<T>(
    query: ResourceQuery<T>,
    placement?: ResourceContentPlacement,
  ): Promise<ResourceQueryState<T>>;
  /** Presence for this owner, without loading the bytes or changing their recency. */
  hasContent(key: ContentKey): Promise<boolean>;
  /** Stored bytes for this owner, without changing their recency. */
  readContent(key: ContentKey): Promise<Uint8Array | undefined>;
  /** Stored bytes the user opened: refreshes recency and protects them from prefetch eviction. */
  openContent(key: ContentKey): Promise<Uint8Array | undefined>;
  readContentByAlias(alias: string): Promise<Uint8Array | undefined>;
  openContentByAlias(alias: string): Promise<Uint8Array | undefined>;
  /** Verifies, applies the caps and the shared budget, and returns false when refused. */
  storeContent(input: ResourceContentInput): Promise<boolean>;
  contentWriteToken(): ResourceContentWriteToken;
  /**
   * Refreshes held content and applies the stronger origin and cohort without transferring its
   * bytes. False when it is not held or the write is refused.
   */
  retainContent(key: ContentKey, retain: ResourceContentRetain): Promise<boolean>;
  dispose(reason?: ResourceConnectionReason): Promise<void>;
}
