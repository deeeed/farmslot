import type { GatewayAuthMode, GatewayWorkspaceAccess } from '../rpc/auth.js';
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

/** Last verified identity only, without credentials, for opening an offline profile. */
export interface ResourceStoreIdentity {
  authMode: GatewayAuthMode;
  metadata: ResourceStoreMetadata;
}

export type ResourceContentOrigin = 'opened' | 'prefetch';
/** Pending-gate content outranks active-run prefetch in eviction. */
export type ResourceContentCohort = 'gate' | 'run';
/** Who placed a budgeted row. A row without an origin was opened. */
export interface ResourceContentPlacement {
  origin?: ResourceContentOrigin;
  cohort?: ResourceContentCohort;
}

export interface StoredResourceQueryInfo extends ResourceContentPlacement {
  id: string;
  observedAt: number;
  accessedAt?: number;
  bytes: number;
}

export interface StoredResourceQuery<T = unknown> extends StoredResourceQueryInfo {
  data: T;
}

export interface ResourceStoreByteTotals {
  queries: number;
  content: number;
}

/** Content by identity: a review `diffHash`, a git blob id, or an artifact manifest `sha256`. */
export interface ContentKey {
  kind: 'diff' | 'blob' | 'artifact';
  id: string;
}

export interface StoredResourceContentInfo extends ContentKey {
  bytes: number;
  origin: ResourceContentOrigin;
  cohort: ResourceContentCohort;
  accessedAt: number;
}

export interface StoredResourceContent extends StoredResourceContentInfo {
  data: Uint8Array;
}

/** One row of a row-backed query entry; for the run list, one live run. */
export interface StoredResourceRow {
  /** Unique within its entry: the run id. */
  id: string;
  /** The version the row was served under. */
  version: string;
  /** Always kept: the JSON that filters, search, sorting and totals read. */
  projection: unknown;
  /** The full row as served. Absent past the bound, so the row counts as missing. */
  body?: unknown;
  /** UTF-8 JSON bytes of projection plus body, as the cache counts them. */
  bytes: number;
}

export interface ResourceRowsMerge {
  /** The owning entry, written in the same transaction. Its `bytes` covers its rows after the merge. */
  entry: StoredResourceQuery;
  /** Inserted, or replaced whole, by id. */
  upserts: readonly StoredResourceRow[];
  /**
   * Removed by id; ids with no row are ignored. Deletes apply before upserts, so a row deleted and
   * upserted in the same merge stays stored.
   */
  deletes: readonly string[];
}

export interface StoredResourceRows {
  entry?: StoredResourceQuery;
  rows: StoredResourceRow[];
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
  /** Access recency never changes observation age. Optional for older custom stores. */
  touchQuery?(id: string, accessedAt: number, origin?: ResourceContentOrigin): Promise<void>;
  listQueries(): Promise<StoredResourceQueryInfo[]>;
  /**
   * The entry and every row of `queryId`, from one serial read, so a hydrate never straddles a
   * merge. Rows belong to the entry with their query id: putQuery keeps them, and deleteQuery and
   * deleteAll remove them. Optional for older custom stores, whose run lists then stay in memory.
   */
  getRows?(queryId: string): Promise<StoredResourceRows>;
  /** Writes `merge.entry`, then its deletes and upserts, in one transaction: all or nothing. */
  mergeRows?(queryId: string, merge: ResourceRowsMerge): Promise<void>;
  /** Presence only, without loading the bytes. */
  hasContent(key: ContentKey): Promise<boolean>;
  getContent(key: ContentKey): Promise<StoredResourceContent | undefined>;
  putContent(entry: StoredResourceContent): Promise<void>;
  /** Points an alias at held content, replacing its previous target; deleting the content drops it. */
  putContentAlias(alias: string, key: ContentKey): Promise<void>;
  getContentByAlias(alias: string): Promise<StoredResourceContent | undefined>;
  /** Recency only, plus an optional origin change; the bytes are never rewritten. */
  touchContent(key: ContentKey, accessedAt: number, origin?: ResourceContentOrigin): Promise<void>;
  /** Refreshes recency and applies only a stronger origin ('opened') or cohort ('gate'). */
  retainContent(
    key: ContentKey,
    accessedAt: number,
    placement: ResourceContentPlacement,
  ): Promise<void>;
  deleteContent(key: ContentKey): Promise<void>;
  listContent(): Promise<StoredResourceContentInfo[]>;
  byteTotals(): Promise<ResourceStoreByteTotals>;
  deleteAll(): Promise<void>;
  close(): Promise<void>;
}

function copy<T>(value: T): T {
  // Registered query results are JSON replies, including on React Native without structuredClone.
  return JSON.parse(JSON.stringify(value)) as T;
}

export function resourceContentId(key: ContentKey): string {
  return `${key.kind}:${key.id}`;
}

function contentInfo({
  kind,
  id,
  bytes,
  origin,
  cohort,
  accessedAt,
}: StoredResourceContentInfo): StoredResourceContentInfo {
  return { kind, id, bytes, origin, cohort, accessedAt };
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
  const rows = new Map<string, Map<string, StoredResourceRow>>();
  const contents = new Map<string, StoredResourceContent>();
  const aliases = new Map<string, string>();
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
    async touchQuery(id, accessedAt, origin) {
      if (available()) {
        const entry = entries.get(id);
        if (entry) entry.accessedAt = accessedAt;
        if (entry && origin) entry.origin = origin;
      }
    },
    async deleteQuery(id) {
      if (!available()) return;
      entries.delete(id);
      rows.delete(id);
    },
    async getRows(queryId) {
      const entry = available() ? entries.get(queryId) : undefined;
      return {
        ...(entry ? { entry: copy(entry) } : {}),
        rows: available() ? [...(rows.get(queryId)?.values() ?? [])].map(copy) : [],
      };
    },
    async mergeRows(queryId, merge) {
      if (!available()) return;
      if (merge.entry.id !== queryId) throw new Error('A row merge writes its own entry');
      // Copy everything before changing anything, so a failure leaves the store as it was.
      const entry = copy(merge.entry);
      const upserts = merge.upserts.map(copy);
      const next = new Map(rows.get(queryId));
      for (const id of merge.deletes) next.delete(id);
      for (const row of upserts) next.set(row.id, row);
      entries.set(queryId, entry);
      rows.set(queryId, next);
    },
    async listQueries() {
      return available()
        ? [...entries.values()].map(({ id, observedAt, accessedAt, bytes, origin, cohort }) => ({
            id,
            observedAt,
            accessedAt,
            bytes,
            origin,
            cohort,
          }))
        : [];
    },
    async hasContent(key) {
      return available() && contents.has(resourceContentId(key));
    },
    async getContent(key) {
      const entry = available() ? contents.get(resourceContentId(key)) : undefined;
      return entry ? { ...contentInfo(entry), data: new Uint8Array(entry.data) } : undefined;
    },
    async putContentAlias(alias, key) {
      if (available() && contents.has(resourceContentId(key)))
        aliases.set(alias, resourceContentId(key));
    },
    async getContentByAlias(alias) {
      const id = available() ? aliases.get(alias) : undefined;
      const entry = id === undefined ? undefined : contents.get(id);
      return entry ? { ...contentInfo(entry), data: new Uint8Array(entry.data) } : undefined;
    },
    async putContent(entry) {
      if (available())
        contents.set(resourceContentId(entry), {
          ...contentInfo(entry),
          data: new Uint8Array(entry.data),
        });
    },
    async touchContent(key, accessedAt, origin) {
      const entry = available() ? contents.get(resourceContentId(key)) : undefined;
      if (entry) {
        entry.accessedAt = accessedAt;
        if (origin) entry.origin = origin;
      }
    },
    async retainContent(key, accessedAt, { origin, cohort }) {
      const entry = available() ? contents.get(resourceContentId(key)) : undefined;
      if (!entry) return;
      entry.accessedAt = accessedAt;
      if (origin === 'opened') entry.origin = origin;
      if (cohort === 'gate') entry.cohort = cohort;
    },
    async deleteContent(key) {
      if (!available()) return;
      const id = resourceContentId(key);
      contents.delete(id);
      for (const [alias, target] of aliases) if (target === id) aliases.delete(alias);
    },
    async listContent() {
      return available() ? [...contents.values()].map(contentInfo) : [];
    },
    async byteTotals() {
      const sum = (values: Iterable<{ bytes: number }>) =>
        available() ? [...values].reduce((total, entry) => total + entry.bytes, 0) : 0;
      return { queries: sum(entries.values()), content: sum(contents.values()) };
    },
    async deleteAll() {
      if (deleted) return;
      deleted = true;
      entries.clear();
      rows.clear();
      contents.clear();
      aliases.clear();
      metadata = undefined;
      for (const listener of deletionListeners) listener();
    },
    async close() {
      closed = true;
      deletionListeners.clear();
    },
  };
}
