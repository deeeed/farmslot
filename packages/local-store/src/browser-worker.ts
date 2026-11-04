import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';

import type { ResourceSqliteDatabase } from './sqlite-store.js';
import { createWasmSqliteDriver } from './wasm-driver.js';
import { createStoreWorkerHandler, type WorkerDatabase } from './worker-handler.js';
import type { StoreWorkerRequest, StoreWorkerResponse } from './worker-protocol.js';

declare const self: DedicatedWorkerGlobalScope;
const worker = self;
const sqlite = sqlite3InitModule();

async function createHandler() {
  const library = await sqlite;
  const pool = await library.installOpfsSAHPoolVfs({
    directory: '/farmslot-resource-store',
    initialCapacity: 6,
    preserveOnInitFailure: true,
  });
  const connections = new Map<string, { database: Database; driver: ResourceSqliteDatabase }>();
  const databases = new Map<string, WorkerDatabase>();
  const connection = (filename: string) => {
    let opened = connections.get(filename);
    if (!opened) {
      const database = new pool.OpfsSAHPoolDb(filename);
      database.exec('PRAGMA foreign_keys = ON');
      opened = { database, driver: createWasmSqliteDriver(database) };
      connections.set(filename, opened);
    }
    return opened.driver;
  };
  let responses: StoreWorkerResponse[] = [];
  const handle = createStoreWorkerHandler(
    async (filename) => {
      let opened = databases.get(filename);
      if (!opened) {
        // Stable driver identity preserves the store's serial executor and deletion fences.
        opened = {
          database: {
            run: (sql, params) => connection(filename).run(sql, params),
            all: (sql, params) => connection(filename).all(sql, params),
          },
          storage: 'opfs-sahpool',
        };
        databases.set(filename, opened);
      }
      return opened;
    },
    (response) => responses.push(response),
  );
  return async (request: StoreWorkerRequest) => {
    responses = [];
    await pool.unpauseVfs();
    try {
      await handle(request);
    } finally {
      for (const { database } of connections.values()) database.close();
      connections.clear();
      // SQLite requires all connections closed before releasing the OPFS access handles.
      pool.pauseVfs();
    }
    return responses;
  };
}

let handler: ReturnType<typeof createHandler> | undefined;
worker.onmessage = async (event: MessageEvent<StoreWorkerRequest>) => {
  const request = event.data;
  try {
    const responses = await navigator.locks.request(
      'farmslot-resource-store-owner-v1',
      async () => {
        const handle = await (handler ??= createHandler());
        return handle(request);
      },
    );
    for (const response of responses) worker.postMessage(response);
  } catch (error) {
    worker.postMessage({
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    } satisfies StoreWorkerResponse);
  }
};
