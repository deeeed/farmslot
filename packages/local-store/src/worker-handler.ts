import type { ResourceStore } from '@farmslot/protocol/client-cache';

import {
  createSqliteResourceStore,
  deleteSqliteResourceStoreScope,
  readSqliteStoreDiagnostics,
  type ResourceSqliteDatabase,
} from './sqlite-store.js';
import type {
  BrowserStoreDiagnostics,
  StoreWorkerRequest,
  StoreWorkerResponse,
} from './worker-protocol.js';

export interface WorkerDatabase {
  database: ResourceSqliteDatabase;
  storage: BrowserStoreDiagnostics['storage'];
}

/** The browser worker and the Node worker conformance fixture use the same dispatcher. */
export function createStoreWorkerHandler(
  openDatabase: (filename: string) => Promise<WorkerDatabase>,
  send: (response: StoreWorkerResponse) => void,
) {
  let nextHandle = 0;
  const stores = new Map<number, ResourceStore>();
  return async (request: StoreWorkerRequest): Promise<void> => {
    try {
      let value: unknown;
      if (request.operation === 'open') {
        const opened = await openDatabase(request.databaseName ?? '/resources.sqlite');
        const store = await createSqliteResourceStore({
          database: opened.database,
          scope: request.scope,
          schemaVersion: request.schemaVersion,
          onDeleted: (scopeId) => send({ event: 'scope-deleted', scopeId }),
        });
        const handle = ++nextHandle;
        stores.set(handle, store);
        store.onDeleted(() => send({ event: 'deleted', handle }));
        value = handle;
      } else if (request.operation === 'deleteScope') {
        const opened = await openDatabase(request.databaseName ?? '/resources.sqlite');
        await deleteSqliteResourceStoreScope(opened.database, request.scopeId);
      } else if (request.operation === 'diagnostics') {
        const filename = request.databaseName ?? '/resources.sqlite';
        const opened = await openDatabase(filename);
        value = {
          storage: opened.storage,
          databaseName: filename,
          ...(await readSqliteStoreDiagnostics(opened.database)),
        } satisfies BrowserStoreDiagnostics;
      } else {
        const store = stores.get(request.handle);
        if (!store) throw new Error('Resource store worker handle is closed');
        switch (request.operation) {
          case 'getMetadata':
            value = await store.getMetadata();
            break;
          case 'setMetadata':
            value = await store.setMetadata(request.metadata);
            break;
          case 'getQuery':
            value = await store.getQuery(request.key);
            break;
          case 'putQuery':
            value = await store.putQuery(request.entry);
            break;
          case 'touchQuery':
            value = await store.touchQuery?.(request.key, request.accessedAt);
            break;
          case 'deleteQuery':
            value = await store.deleteQuery(request.key);
            break;
          case 'listQueries':
            value = await store.listQueries();
            break;
          case 'byteTotals':
            value = await store.byteTotals();
            break;
          case 'deleteAll':
            value = await store.deleteAll();
            break;
          case 'close':
            value = await store.close();
            stores.delete(request.handle);
            break;
        }
      }
      send({ id: request.id, ok: true, value });
    } catch (error) {
      send({
        id: request.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
