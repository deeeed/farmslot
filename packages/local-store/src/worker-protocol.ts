import type {
  ContentKey,
  ResourceContentOrigin,
  ResourceStoreMetadata,
  ResourceStoreScope,
  StoredResourceContent,
  StoredResourceQuery,
} from '@farmslot/protocol/client-cache';

export type StoreWorkerRequest =
  | {
      id: number;
      operation: 'open';
      scope: ResourceStoreScope;
      databaseName?: string;
      schemaVersion?: number;
    }
  | { id: number; operation: 'diagnostics'; databaseName?: string }
  | { id: number; operation: 'deleteScope'; scopeId: string; databaseName?: string }
  | {
      id: number;
      operation:
        | 'getMetadata'
        | 'listQueries'
        | 'listContent'
        | 'byteTotals'
        | 'deleteAll'
        | 'close';
      handle: number;
    }
  | { id: number; operation: 'getQuery' | 'deleteQuery'; handle: number; key: string }
  | { id: number; operation: 'touchQuery'; handle: number; key: string; accessedAt: number }
  | { id: number; operation: 'setMetadata'; handle: number; metadata: ResourceStoreMetadata }
  | { id: number; operation: 'putQuery'; handle: number; entry: StoredResourceQuery }
  | {
      id: number;
      operation: 'hasContent' | 'getContent' | 'deleteContent';
      handle: number;
      key: ContentKey;
    }
  | { id: number; operation: 'putContentAlias'; handle: number; alias: string; key: ContentKey }
  | { id: number; operation: 'getContentByAlias'; handle: number; alias: string }
  | {
      id: number;
      operation: 'touchContent';
      handle: number;
      key: ContentKey;
      accessedAt: number;
      origin?: ResourceContentOrigin;
    }
  | { id: number; operation: 'putContent'; handle: number; entry: StoredResourceContent };

export type StoreWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string }
  | { event: 'deleted'; handle: number }
  | { event: 'scope-deleted'; scopeId: string };

export interface StoreWorkerPort {
  postMessage(request: StoreWorkerRequest): void;
  onMessage(listener: (response: StoreWorkerResponse) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  terminate(): void;
}

export interface BrowserStoreDiagnostics {
  storage: 'opfs-sahpool' | 'memory-test';
  databaseName: string;
  integrity: string;
  schemaVersion: number;
  storeCount: number;
}

export type StoreWorkerOperation = StoreWorkerRequest extends infer Request
  ? Request extends StoreWorkerRequest
    ? Omit<Request, 'id'>
    : never
  : never;
