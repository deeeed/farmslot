import type { GatewayWorkspaceAccess } from '../rpc/auth.js';
import type { RoleBinding } from '../rpc/principal.js';

import { canonicalResourceJson } from './keys.js';

export interface ResourceStoreScope {
  gatewayUrl: string;
  profileId?: string;
  principalId?: string;
  principalGeneration?: number;
}

export interface ResourceStoreAuthority {
  roles: RoleBinding[];
  workspaceAccess: GatewayWorkspaceAccess;
}

export interface ResourceStoreMetadata {
  scope: ResourceStoreScope;
  authority: ResourceStoreAuthority;
}

export interface StoredResourceQueryInfo {
  id: string;
  observedAt: number;
  bytes: number;
}

export interface StoredResourceQuery<T = unknown> extends StoredResourceQueryInfo {
  data: T;
}

export interface ResourceStoreByteTotals {
  queries: number;
  content: number;
}

/** Experimental store seam. deleteAll seals this incarnation against late reads and writes. */
export interface ResourceStore {
  readonly persistent: boolean;
  readonly deleted: boolean;
  onDeleted(listener: () => void): () => void;
  getMetadata(): Promise<ResourceStoreMetadata | undefined>;
  setMetadata(metadata: ResourceStoreMetadata): Promise<void>;
  getQuery<T = unknown>(id: string): Promise<StoredResourceQuery<T> | undefined>;
  putQuery<T>(entry: StoredResourceQuery<T>): Promise<void>;
  deleteQuery(id: string): Promise<void>;
  listQueries(): Promise<StoredResourceQueryInfo[]>;
  byteTotals(): Promise<ResourceStoreByteTotals>;
  deleteAll(): Promise<void>;
  close(): Promise<void>;
}

function copy<T>(value: T): T {
  // Registered query results are JSON replies, including on React Native without structuredClone.
  return JSON.parse(JSON.stringify(value)) as T;
}

export function resourceStoreScopeId(scope: ResourceStoreScope): string {
  return canonicalResourceJson(normalizeResourceStoreScope(scope));
}

export function normalizeResourceStoreScope(scope: ResourceStoreScope): ResourceStoreScope {
  const url = new URL(scope.gatewayUrl);
  url.hash = '';
  url.search = '';
  url.username = '';
  url.password = '';
  return { ...scope, gatewayUrl: url.href };
}

export function sameResourceAuthority(
  a: ResourceStoreAuthority,
  b: ResourceStoreAuthority,
): boolean {
  const roles = (authority: ResourceStoreAuthority) =>
    [...new Set(authority.roles.map(canonicalResourceJson))].sort();
  return (
    a.workspaceAccess === b.workspaceAccess &&
    canonicalResourceJson(roles(a)) === canonicalResourceJson(roles(b))
  );
}

export function createMemoryResourceStore(): ResourceStore {
  const entries = new Map<string, StoredResourceQuery>();
  let metadata: ResourceStoreMetadata | undefined;
  let deleted = false;
  let closed = false;
  const deletionListeners = new Set<() => void>();
  const available = () => !deleted && !closed;
  return {
    persistent: false,
    get deleted() {
      return deleted;
    },
    onDeleted(listener) {
      deletionListeners.add(listener);
      return () => {
        deletionListeners.delete(listener);
      };
    },
    async getMetadata() {
      return available() && metadata ? copy(metadata) : undefined;
    },
    async setMetadata(next) {
      if (available()) metadata = copy(next);
    },
    async getQuery<T>(id: string) {
      return available() && entries.has(id)
        ? copy(entries.get(id) as StoredResourceQuery<T>)
        : undefined;
    },
    async putQuery(entry) {
      if (available()) entries.set(entry.id, copy(entry));
    },
    async deleteQuery(id) {
      if (available()) entries.delete(id);
    },
    async listQueries() {
      return available()
        ? [...entries.values()].map(({ id, observedAt, bytes }) => ({ id, observedAt, bytes }))
        : [];
    },
    async byteTotals() {
      return {
        queries: available()
          ? [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
          : 0,
        content: 0,
      };
    },
    async deleteAll() {
      if (deleted) return;
      deleted = true;
      entries.clear();
      metadata = undefined;
      for (const listener of deletionListeners) listener();
    },
    async close() {
      closed = true;
      deletionListeners.clear();
    },
  };
}
