import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { createWasmSqliteDriver } from './wasm-driver.js';
import { createStoreWorkerHandler, type WorkerDatabase } from './worker-handler.js';
import type { StoreWorkerRequest } from './worker-protocol.js';

declare const self: DedicatedWorkerGlobalScope;
const worker = self;
const pool = sqlite3InitModule().then((sqlite) =>
  sqlite.installOpfsSAHPoolVfs({
    directory: '/farmslot-resource-store',
    initialCapacity: 6,
    preserveOnInitFailure: true,
  }),
);
const databases = new Map<string, Promise<WorkerDatabase>>();
const handle = createStoreWorkerHandler(
  (filename) => {
    let database = databases.get(filename);
    if (!database) {
      database = pool.then((opened) => ({
        database: createWasmSqliteDriver(new opened.OpfsSAHPoolDb(filename)),
        storage: 'opfs-sahpool' as const,
      }));
      databases.set(filename, database);
    }
    return database;
  },
  (response) => worker.postMessage(response),
);
worker.onmessage = (event: MessageEvent<StoreWorkerRequest>) => {
  void handle(event.data);
};
