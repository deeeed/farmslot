import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createGatewayResourceCache,
  resourceQuery,
  type ResourceStore,
  resourceStoreScopeId,
  runResourceStoreConformance,
} from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../protocol/src/client-cache/conformance.js';
import { createExpoSqliteDriver } from '../src/native.js';
import {
  createSqliteResourceStore,
  deleteSqliteResourceStoreScope,
  readSqliteResourceQueryInfo,
  RESOURCE_STORE_SCHEMA_VERSION,
  type ResourceSqliteDatabase,
  type SqliteValue,
} from '../src/sqlite-store.js';

function database(sqlite = new DatabaseSync(':memory:')) {
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
    assert.equal(passed.length, 20);
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
    assert.equal(passed.length, 20);
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
      schemaVersion: RESOURCE_STORE_SCHEMA_VERSION + 1,
    });
    assert(old.deleted);
    await old.putQuery({ id: 'q', data: { value: 'late old handle' }, observedAt: 2, bytes: 22 });
    assert.equal(await fresh.getQuery('q'), undefined);
    assert.equal(
      sqlite.prepare('PRAGMA user_version').get()?.user_version,
      RESOURCE_STORE_SCHEMA_VERSION + 1,
    );
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

test('schema 4 rebuilds an older store and keeps content as exact SQLite blobs', async () => {
  const { sqlite, adapter } = database();
  const old = await createSqliteResourceStore({
    database: adapter,
    scope: scope('blob'),
    schemaVersion: 2,
  });
  await old.putQuery({ id: 'q', data: { value: 'schema 2' }, observedAt: 1, bytes: 20 });
  const store = await createSqliteResourceStore({ database: adapter, scope: scope('blob') });
  try {
    assert.equal(RESOURCE_STORE_SCHEMA_VERSION, 4);
    assert.equal(sqlite.prepare('PRAGMA user_version').get()?.user_version, 4);
    assert(old.deleted);
    assert.equal(await store.getQuery('q'), undefined);
    const data = new Uint8Array(1024 * 1024 + 256).map((_, index) => index % 256);
    await store.putContent({
      kind: 'artifact',
      id: 'binary',
      data,
      bytes: data.byteLength,
      origin: 'prefetch',
      cohort: 'gate',
      accessedAt: 7,
    });
    const saved = await store.getContent({ kind: 'artifact', id: 'binary' });
    assert.deepEqual(saved?.data, data);
    assert.equal(
      sqlite.prepare('SELECT typeof(data) AS type FROM resource_content').get()?.type,
      'blob',
    );
    assert.deepEqual(await store.byteTotals(), { queries: 0, content: data.byteLength });
    const aliases = () =>
      sqlite.prepare('SELECT COUNT(*) AS count FROM resource_content_aliases').get()?.count;
    await store.putContentAlias('frozen-diff:run:base:head', { kind: 'artifact', id: 'binary' });
    assert.equal(await store.hasContent({ kind: 'artifact', id: 'binary' }), true);
    assert.deepEqual((await store.getContentByAlias('frozen-diff:run:base:head'))?.data, data);
    assert.equal(aliases(), 1);
    await store.deleteContent({ kind: 'artifact', id: 'binary' });
    assert.equal(aliases(), 0);
    assert.equal(await store.hasContent({ kind: 'artifact', id: 'binary' }), false);
  } finally {
    await old.close();
    await store.close();
    sqlite.close();
  }
});

// Schema 3 as released with content and aliases, before query rows gained `origin` and `cohort`.
const schema3 = [
  `CREATE TABLE resource_stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id TEXT NOT NULL UNIQUE,
    metadata TEXT,
    last_used INTEGER NOT NULL
  )`,
  `CREATE TABLE resource_queries (
    store_id INTEGER NOT NULL REFERENCES resource_stores(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (store_id, id)
  )`,
  `CREATE TABLE resource_content (
    store_id INTEGER NOT NULL REFERENCES resource_stores(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    data BLOB,
    bytes INTEGER NOT NULL,
    origin TEXT NOT NULL,
    cohort TEXT NOT NULL,
    accessed_at INTEGER NOT NULL,
    PRIMARY KEY (store_id, kind, id)
  )`,
  `CREATE TABLE resource_content_aliases (
    store_id INTEGER NOT NULL,
    alias TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (store_id, alias),
    FOREIGN KEY (store_id, kind, id)
      REFERENCES resource_content(store_id, kind, id) ON DELETE CASCADE
  )`,
  'PRAGMA user_version = 3',
];

test('a real schema 3 database is rebuilt as schema 4: rows are cleared and drafts are kept', async () => {
  const { sqlite, adapter } = database();
  const identity = scope('schema-3');
  for (const statement of schema3) sqlite.exec(statement);
  sqlite
    .prepare('INSERT INTO resource_stores (id, scope_id, metadata, last_used) VALUES (1, ?, ?, 1)')
    .run(resourceStoreScopeId(identity), JSON.stringify({ scope: identity }));
  sqlite
    .prepare('INSERT INTO resource_queries VALUES (1, ?, ?, 1, 17, 2)')
    .run('fs.read:{}', JSON.stringify({ value: 'schema 3' }));
  sqlite
    .prepare("INSERT INTO resource_content VALUES (1, 'blob', 'held', ?, 3, 'opened', 'gate', 3)")
    .run(new Uint8Array([1, 2, 3]));
  sqlite.exec(
    "INSERT INTO resource_content_aliases VALUES (1, 'frozen-diff:run:a:b', 'blob', 'held')",
  );
  sqlite.exec("CREATE TABLE drafts (text TEXT); INSERT INTO drafts VALUES ('keep draft')");
  const count = (table: string) =>
    sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count;
  const store = await createSqliteResourceStore({ database: adapter, scope: identity });
  try {
    assert.equal(sqlite.prepare('PRAGMA user_version').get()?.user_version, 4);
    assert.deepEqual(
      sqlite
        .prepare('PRAGMA table_info(resource_queries)')
        .all()
        .map(({ name }) => name),
      ['store_id', 'id', 'data', 'observed_at', 'bytes', 'accessed_at', 'origin', 'cohort'],
    );
    assert.equal(await store.getMetadata(), undefined);
    assert.equal(await store.getQuery('fs.read:{}'), undefined);
    assert.equal(await store.hasContent({ kind: 'blob', id: 'held' }), false);
    assert.equal(await store.getContentByAlias('frozen-diff:run:a:b'), undefined);
    for (const table of ['resource_queries', 'resource_content', 'resource_content_aliases'])
      assert.equal(count(table), 0);
    assert.equal(count('resource_stores'), 1);
    assert.deepEqual(
      sqlite
        .prepare('SELECT text FROM drafts')
        .all()
        .map(({ text }) => text),
      ['keep draft'],
    );
    await store.putQuery({
      id: 'fs.read:{}',
      data: { value: 'schema 4' },
      observedAt: 4,
      bytes: 20,
      origin: 'prefetch',
      cohort: 'gate',
    });
    const saved = await store.getQuery('fs.read:{}');
    assert.equal(saved?.origin, 'prefetch');
    assert.equal(saved?.cohort, 'gate');
    assert.equal(sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await store.close();
    sqlite.close();
  }
});

test('deleting a scope from a connection that never opened a store removes its content blobs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'local-store-content-'));
  const filename = join(directory, 'resources.sqlite');
  const first = database(new DatabaseSync(filename));
  const store = await createSqliteResourceStore({ database: first.adapter, scope: scope('scope') });
  await store.putContent({
    kind: 'blob',
    id: 'held',
    data: new Uint8Array([1, 2, 3]),
    bytes: 3,
    origin: 'opened',
    cohort: 'run',
    accessedAt: 1,
  });
  await store.putContentAlias('alias', { kind: 'blob', id: 'held' });
  await store.close();
  first.sqlite.close();
  const second = database(new DatabaseSync(filename, { enableForeignKeyConstraints: false }));
  try {
    await deleteSqliteResourceStoreScope(second.adapter, resourceStoreScopeId(scope('scope')));
    for (const table of ['resource_content', 'resource_content_aliases'])
      assert.equal(second.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
  } finally {
    second.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a prefetched slot diff keeps its placement in SQLite and cannot evict opened content', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1 });
  const { sqlite, adapter } = database();
  const identity = scope('placement');
  const store = await createSqliteResourceStore({ database: adapter, scope: identity });
  const transport = new ResourceCacheConformanceTransport(identity);
  transport.setConnection({
    connected: true,
    id: 1,
    capabilities: {
      ...transport.connection.capabilities!,
      resourceChanges: {
        version: 1,
        epoch: 'conformance-epoch',
        versionLists: false,
        observedReads: 1,
        workspaceReads: 1,
      },
    },
  });
  const cache = createGatewayResourceCache({ transport, store, contentBudgetBytes: 100 });
  const query = (slotId: string) =>
    resourceQuery<{ value: string }>('git.diff', {
      slotId,
      runId: 'run',
      base: 'main',
      target: 'worktree',
      includeUntracked: true,
    });
  const prefetch = async (slotId: string) => {
    const reading = cache.retry(query(slotId), { origin: 'prefetch', cohort: 'run' });
    (await transport.nextRead()).resolve({ value: 'x'.repeat(28) });
    await reading;
  };
  try {
    await prefetch('first');
    assert.deepEqual(
      sqlite
        .prepare('SELECT origin, cohort FROM resource_queries')
        .all()
        .map(({ origin, cohort }) => ({ origin, cohort })),
      [{ origin: 'prefetch', cohort: 'run' }],
    );
    t.mock.timers.tick(1);
    const opened = new Uint8Array(60).fill(1);
    await store.putContent({
      kind: 'artifact',
      id: 'opened',
      data: opened,
      bytes: 60,
      origin: 'opened',
      cohort: 'run',
      accessedAt: Date.now(),
    });
    t.mock.timers.tick(1);
    await prefetch('second');
    assert.deepEqual(
      (await store.listQueries()).map(({ id, origin }) => ({ id, origin })),
      [{ id: query('second').id, origin: 'prefetch' }],
    );
    assert.equal(await store.hasContent({ kind: 'artifact', id: 'opened' }), true);
  } finally {
    await cache.dispose();
    sqlite.close();
  }
});
