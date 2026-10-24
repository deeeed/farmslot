import type {
  ResourceStoreMetadata,
  ResourceStoreScope,
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
      operation: 'getMetadata' | 'listQueries' | 'byteTotals' | 'deleteAll' | 'close';
      handle: number;
    }
  | { id: number; operation: 'getQuery' | 'deleteQuery'; handle: number; key: string }
  | { id: number; operation: 'touchQuery'; handle: number; key: string; accessedAt: number }
  | { id: number; operation: 'setMetadata'; handle: number; metadata: ResourceStoreMetadata }
  | { id: number; operation: 'putQuery'; handle: number; entry: StoredResourceQuery };

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
