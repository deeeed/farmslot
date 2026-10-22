import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  type ResourceStore,
  resourceStoreScopeId,
  runResourceStoreConformance,
} from '@farmslot/protocol/client-cache';

import { createExpoSqliteDriver } from '../src/native.js';
import {
  createSqliteResourceStore,
  readSqliteResourceQueryInfo,
  type ResourceSqliteDatabase,
  type SqliteValue,
} from '../src/sqlite-store.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const adapter: ResourceSqliteDatabase = {
    async run(sql, params = []) {
      sqlite.prepare(sql).run(...params);
    },
    async all<T>(sql: string, params: readonly SqliteValue[] = []) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
  };
  return { sqlite, adapter };
}
const scope = (profileId: string) => ({
  gatewayUrl: 'ws://sqlite.invalid/',
  profileId,
  principalId: 'p',
  principalGeneration: 0,
});

test('query metadata inspection waits behind a writer and reads only its exact store scope', async () => {
  const { sqlite, adapter } = database();
  const store = await createSqliteResourceStore({ database: adapter, scope: scope('first') });
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = adapter.run;
  adapter.run = async (sql, params) => {
    if (sql.startsWith('INSERT INTO resource_queries')) {
      start();
      await held;
    }
    await run(sql, params);
  };
  try {
    const writing = store.putQuery({
      id: 'query',
      data: { value: 'private' },
      observedAt: 123,
      bytes: 19,
    });
    await started;
    let completed = false;
    const reading = readSqliteResourceQueryInfo(
      adapter,
      resourceStoreScopeId(scope('first')),
      'query',
    );
    void reading.then(() => {
      completed = true;
    });
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    release();
    await writing;
    assert.deepEqual({ ...(await reading) }, { id: 'query', observedAt: 123, bytes: 19 });
    assert.equal(
      await readSqliteResourceQueryInfo(adapter, resourceStoreScopeId(scope('other')), 'query'),
      undefined,
    );
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM resource_stores').get()?.count, 1);
  } finally {
    release();
    await store.close();
    sqlite.close();
  }
});

test('SQL store runs the exported cache/store conformance against real SQLite', async () => {
  const { sqlite, adapter } = database();
  try {
    const passed = await runResourceStoreConformance((identity) =>
      createSqliteResourceStore({ database: adapter, scope: identity }),
    );
    assert.equal(passed.length, 18);
    assert.equal(sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally {
    sqlite.close();
  }
});

test('the Expo adapter runs the portable conformance contract through real SQLite', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const adapter = createExpoSqliteDriver({
    async runAsync(sql, params) {
      return sqlite.prepare(sql).run(...params);
    },
    async getAllAsync<T>(sql: string, params: SqliteValue[]) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
  });
  try {
    const passed = await runResourceStoreConformance((identity) =>
      createSqliteResourceStore({ database: adapter, scope: identity }),
    );
    assert.equal(passed.length, 18);
  } finally {
    sqlite.close();
  }
});

test('schema reset rebuilds the query cache and fences the old open handle', async () => {
  const { sqlite, adapter } = database();
  let old: ResourceStore | undefined;
  let fresh: ResourceStore | undefined;
  try {
    old = await createSqliteResourceStore({ database: adapter, scope: scope('schema') });
    await old.putQuery({ id: 'q', data: { value: 'old schema' }, observedAt: 1, bytes: 22 });
    fresh = await createSqliteResourceStore({
      database: adapter,
      scope: scope('schema'),
      schemaVersion: 2,
    });
    assert(old.deleted);
    await old.putQuery({ id: 'q', data: { value: 'late old handle' }, observedAt: 2, bytes: 22 });
    assert.equal(await fresh.getQuery('q'), undefined);
    assert.equal(sqlite.prepare('PRAGMA user_version').get()?.user_version, 2);
  } finally {
    await old?.close();
    await fresh?.close();
    sqlite.close();
  }
});

test('sixth scope evicts the least recently used store including read access', async () => {
  const { sqlite, adapter } = database();
  const stores: ResourceStore[] = [];
  try {
    for (let i = 0; i < 5; i++)
      stores.push(
        await createSqliteResourceStore({ database: adapter, scope: scope(`profile-${i}`) }),
      );
    await stores[0].getMetadata();
    stores.push(await createSqliteResourceStore({ database: adapter, scope: scope('profile-5') }));
    assert.equal(stores[0].deleted, false);
    assert.equal(stores[1].deleted, true);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM resource_stores').get()?.count, 5);
  } finally {
    for (const store of stores) await store.close();
    sqlite.close();
  }
});
