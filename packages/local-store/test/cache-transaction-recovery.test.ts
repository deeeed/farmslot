import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { RunListParams, RunListResult } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  type ResourceCacheTransport,
  resourceQuery,
  type ResourceReadResult,
} from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../protocol/src/client-cache/conformance.js';
import { storedRun } from '../../protocol/test/fixtures/run.js';
import type { ResourceSqliteDatabase, SqliteValue } from '../src/sqlite-store.js';
import { ResourceStoreWorkerClient } from '../src/worker-client.js';
import { createStoreWorkerHandler } from '../src/worker-handler.js';
import type { StoreWorkerPort, StoreWorkerResponse } from '../src/worker-protocol.js';

test('a real SQLite auto-abort retires the worker and resyncs run rows without reconnect', async () => {
  const scope = {
    gatewayUrl: 'ws://transaction.invalid',
    principalId: 'owner',
    principalGeneration: 0,
  };
  const connection = new ResourceCacheConformanceTransport(scope);
  connection.setConnection({
    connected: true,
    id: 1,
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      resourceChanges: { version: 1, epoch: 'epoch', versionLists: true },
    },
  });
  const current = storedRun('current');
  let versionReads = 0;
  const transport: ResourceCacheTransport = {
    ...connection,
    getConnection: connection.getConnection,
    onConnectionChange: connection.onConnectionChange,
    onResourceChanged: connection.onResourceChanged,
    resynchronize: () => assert.fail('Storage recovery must not require a reconnect'),
    async request<T>(_method: string, params: unknown): Promise<ResourceReadResult<T>> {
      const input = params as RunListParams;
      if (input.versions) versionReads++;
      const data: RunListResult = {
        runs: input.versions ? [] : [current],
        totalCount: 1,
        versions: [{ id: current.id, version: 'v1' }],
      };
      return {
        data: data as T,
        resourceState: {
          epoch: 'epoch',
          dependencies: [{ key: { family: 'runs', scope: 'farm' }, revision: 1 }],
        },
      };
    },
  };
  let opens = 0,
    retired = 0;
  const clients: ResourceStoreWorkerClient[] = [];
  const databases: DatabaseSync[] = [];
  const notices: Array<string | undefined> = [];
  const cache = createGatewayResourceCache({
    transport,
    onStorageNotice: (notice) => notices.push(notice),
    openStore: async () => {
      const attempt = ++opens;
      const sqlite = new DatabaseSync(':memory:');
      databases.push(sqlite);
      let armed = attempt === 1;
      const database: ResourceSqliteDatabase = {
        async run(sql, params = []) {
          if (armed && sql.includes('INSERT INTO resource_rows')) {
            armed = false;
            sqlite.exec(
              "CREATE TEMP TRIGGER abort_merge BEFORE INSERT ON resource_rows BEGIN SELECT RAISE(ROLLBACK, 'automatic transaction abort'); END",
            );
          }
          sqlite.prepare(sql).run(...params);
        },
        async all<T>(sql: string, params: readonly SqliteValue[] = []) {
          return sqlite.prepare(sql).all(...params) as T[];
        },
      };
      let receive: ((response: StoreWorkerResponse) => void) | undefined;
      const handle = createStoreWorkerHandler(
        async () => ({ database, storage: 'memory-test' }),
        (response) => receive?.(response),
      );
      const port: StoreWorkerPort = {
        postMessage: (request) => {
          void handle(request);
        },
        onMessage: (listener) => {
          receive = listener;
          return () => {
            receive = undefined;
          };
        },
        onError: () => () => {},
        terminate: () => {
          retired++;
        },
      };
      const client = new ResourceStoreWorkerClient(port);
      clients.push(client);
      return client.open(scope);
    },
  });
  const query = resourceQuery<RunListResult>('run.list', { limit: 10 });
  const states: string[] = [];
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  const stop = cache.observe(query, (state) => {
    states.push(state.status);
    if (opens === 2 && state.status === 'ready') resolve();
  });
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Automatic run-list recovery did not finish')),
        2000,
      );
      void ready.then(() => clearTimeout(timer));
    });
    await Promise.race([ready, deadline]);
    assert.equal(opens, 2);
    assert.equal(retired, 1);
    assert(versionReads >= 2, 'The gateway version list must be re-read after the failed merge');
    assert(states.includes('stale'));
    assert(notices.some((value) => value?.includes('automatic transaction abort')));
    assert.equal(cache.read(query).storageNotice, undefined);
    assert.deepEqual(
      cache.read(query).data?.runs.map((run) => run.id),
      ['current'],
    );
    const saved = await clients.at(-1)!.open(scope);
    assert.deepEqual(
      (await saved.getRows!(resourceQuery('run.list', { versions: true }).id)).rows.map(
        (row) => row.id,
      ),
      ['current'],
    );
    await saved.close();
  } finally {
    stop();
    await cache.dispose();
    for (const client of clients) client.close();
    for (const sqlite of databases) sqlite.close();
  }
});
