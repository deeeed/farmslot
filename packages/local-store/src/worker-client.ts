import {
  type ResourceStore,
  type ResourceStoreScope,
  resourceStoreScopeId,
  type StoredResourceQuery,
} from '@farmslot/protocol/client-cache';

import type {
  BrowserStoreDiagnostics,
  StoreWorkerOperation,
  StoreWorkerPort,
  StoreWorkerResponse,
} from './worker-protocol.js';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface StoreProxy {
  scopeId: string;
  seal(): void;
}

export class ResourceStoreWorkerClient {
  private nextId = 0;
  private closed = false;
  private failure?: Error;
  private readonly pending = new Map<number, Pending>();
  private readonly stores = new Map<number, StoreProxy>();
  private readonly stopMessages: () => void;
  private readonly stopErrors: () => void;

  constructor(
    private readonly port: StoreWorkerPort,
    private readonly onScopeDeleted?: (scopeId: string) => void,
    private readonly timeoutMs = 10000,
  ) {
    this.stopMessages = port.onMessage((response) => this.receive(response));
    this.stopErrors = port.onError((error) => this.fail(error));
  }

  private receive(response: StoreWorkerResponse): void {
    if ('event' in response) {
      if (response.event === 'deleted') this.stores.get(response.handle)?.seal();
      else {
        this.sealScope(response.scopeId);
        this.onScopeDeleted?.(response.scopeId);
      }
      return;
    }
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.ok) request.resolve(response.value);
    else request.reject(new Error(response.message));
  }

  private request<T>(operation: StoreWorkerOperation): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('Local resource storage did not respond'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.port.postMessage({ ...operation, id });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  sealScope(scopeId: string): void {
    for (const store of this.stores.values()) if (store.scopeId === scopeId) store.seal();
  }

  deleteScope(scopeId: string): Promise<void> {
    this.sealScope(scopeId);
    return this.request({ operation: 'deleteScope', scopeId });
  }

  async open(
    scope: ResourceStoreScope,
    databaseName?: string,
    schemaVersion?: number,
  ): Promise<ResourceStore> {
    const handle = await this.request<number>({
      operation: 'open',
      scope,
      databaseName,
      schemaVersion,
    });
    const scopeId = resourceStoreScopeId(scope);
    let deleted = false;
    let closed = false;
    const listeners = new Set<() => void>();
    const seal = () => {
      if (deleted) return;
      deleted = true;
      for (const listener of listeners) listener();
    };
    this.stores.set(handle, { scopeId, seal });
    const available = () => !closed && !deleted;
    const request = <T>(operation: StoreWorkerOperation) => this.request<T>(operation);
    return {
      persistent: true,
      get deleted() {
        return deleted;
      },
      onDeleted(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async getMetadata() {
        const value = available()
          ? await request<Awaited<ReturnType<ResourceStore['getMetadata']>>>({
              operation: 'getMetadata',
              handle,
            })
          : undefined;
        return available() ? value : undefined;
      },
      async setMetadata(metadata) {
        if (available()) await request({ operation: 'setMetadata', handle, metadata });
      },
      async getQuery<T>(key: string) {
        const value = available()
          ? await request<StoredResourceQuery<T> | undefined>({
              operation: 'getQuery',
              handle,
              key,
            })
          : undefined;
        return available() ? value : undefined;
      },
      async putQuery(entry) {
        if (available()) await request({ operation: 'putQuery', handle, entry });
      },
      async touchQuery(key, accessedAt) {
        if (available()) await request({ operation: 'touchQuery', handle, key, accessedAt });
      },
      async deleteQuery(key) {
        if (available()) await request({ operation: 'deleteQuery', handle, key });
      },
      async listQueries() {
        const value = available()
          ? await request<Awaited<ReturnType<ResourceStore['listQueries']>>>({
              operation: 'listQueries',
              handle,
            })
          : [];
        return available() ? value : [];
      },
      async byteTotals() {
        const value = available()
          ? await request<Awaited<ReturnType<ResourceStore['byteTotals']>>>({
              operation: 'byteTotals',
              handle,
            })
          : { queries: 0, content: 0 };
        return available() ? value : { queries: 0, content: 0 };
      },
      deleteAll: () => {
        if (deleted) return Promise.resolve();
        seal();
        this.onScopeDeleted?.(scopeId);
        return request<void>({ operation: 'deleteAll', handle });
      },
      close: async () => {
        if (closed) return;
        closed = true;
        listeners.clear();
        this.stores.delete(handle);
        // Page teardown already terminated the whole worker. Closing a proxy
        // afterwards releases only its local ownership, with no live port to use.
        if (!this.closed) await request<void>({ operation: 'close', handle });
      },
    };
  }

  diagnostics(databaseName?: string): Promise<BrowserStoreDiagnostics> {
    return this.request({ operation: 'diagnostics', databaseName });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.port.terminate();
  }

  close(): void {
    this.closed = true;
    this.fail(new Error('Local resource storage worker closed'));
    this.stopMessages();
    this.stopErrors();
  }
}
