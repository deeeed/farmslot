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

export interface GatewayResourceCache {
  observe<T>(query: ResourceQuery<T>, listener: (state: ResourceQueryState<T>) => void): () => void;
  read<T>(query: ResourceQuery<T>): ResourceQueryState<T>;
  retry<T>(query: ResourceQuery<T>): Promise<ResourceQueryState<T>>;
  dispose(reason?: ResourceConnectionReason): Promise<void>;
}
