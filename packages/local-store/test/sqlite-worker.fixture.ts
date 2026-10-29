import { parentPort } from 'node:worker_threads';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { createWasmSqliteDriver } from '../src/wasm-driver.js';
import { createStoreWorkerHandler, type WorkerDatabase } from '../src/worker-handler.js';
import type { StoreWorkerRequest } from '../src/worker-protocol.js';

if (!parentPort) throw new Error('The SQLite worker fixture needs a parent port');
const port = parentPort;
const sqlite = sqlite3InitModule();
const databases = new Map<string, Promise<WorkerDatabase>>();
const handle = createStoreWorkerHandler(
  (filename) => {
    let opened = databases.get(filename);
    if (!opened) {
      opened = sqlite.then((library) => ({
        database: createWasmSqliteDriver(new library.oo1.DB(':memory:')),
        storage: 'memory-test' as const,
      }));
      databases.set(filename, opened);
    }
    return opened;
  },
  (response) => port.postMessage(response),
);
port.on('message', (request: StoreWorkerRequest) => {
  void handle(request);
});
