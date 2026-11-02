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
import { createDraftStore, createMemoryDraftStorage } from '../src/drafts.js';
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

test("a store's files go before its row, and a failed file delete leaves the scope to delete again", async () => {
  const { sqlite, adapter } = database();
  const files: string[] = [];
  let fail = true;
  const deleteFiles = async (scopeId: string) => {
    if (fail) throw new Error('disk busy');
    files.push(scopeId);
  };
  const rows = () =>
    (
      sqlite.prepare('SELECT scope_id FROM resource_stores').all() as Array<{ scope_id: string }>
    ).map((row) => row.scope_id);
  const id = resourceStoreScopeId(scope('files'));
  const first = await createSqliteResourceStore({
    database: adapter,
    scope: scope('files'),
    deleteFiles,
  });
  await assert.rejects(first.deleteAll(), /disk busy/);
  assert.deepEqual(rows(), [id], 'the row stays, so the scope is still known to need deletion');
  fail = false;
  // The owner's retry: open the revoked scope again and delete it.
  const retry = await createSqliteResourceStore({
    database: adapter,
    scope: scope('files'),
    deleteFiles,
  });
  await retry.deleteAll();
  assert.deepEqual(files, [id]);
  assert.deepEqual(rows(), []);
});

test('a scope evicted past the store limit takes its files with it', async () => {
  const { adapter } = database();
  const files: string[] = [];
  const deleteFiles = async (scopeId: string) => {
    files.push(scopeId);
  };
  for (const name of ['s1', 's2', 's3', 's4', 's5', 's6'])
    await createSqliteResourceStore({ database: adapter, scope: scope(name), deleteFiles });
  assert.deepEqual(files, [resourceStoreScopeId(scope('s1'))]);
});

test('SQL store runs the exported cache/store conformance against real SQLite', async () => {
  const { sqlite, adapter } = database();
  try {
    const passed = await runResourceStoreConformance((identity) =>
      createSqliteResourceStore({ database: adapter, scope: identity }),
    );
    assert.equal(passed.length, 22);
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
    assert.equal(passed.length, 22);
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

test('the current schema rebuilds an older store and keeps content as exact SQLite blobs', async () => {
  const { sqlite, adapter } = database();
  const old = await createSqliteResourceStore({
    database: adapter,
    scope: scope('blob'),
    schemaVersion: 2,
  });
  await old.putQuery({ id: 'q', data: { value: 'schema 2' }, observedAt: 1, bytes: 20 });
  const store = await createSqliteResourceStore({ database: adapter, scope: scope('blob') });
  try {
    assert.equal(RESOURCE_STORE_SCHEMA_VERSION, 5);
    assert.equal(sqlite.prepare('PRAGMA user_version').get()?.user_version, 5);
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

test('a real schema 3 database is rebuilt as the current schema: rows are cleared and drafts are kept', async () => {
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
    assert.equal(
      sqlite.prepare('PRAGMA user_version').get()?.user_version,
      RESOURCE_STORE_SCHEMA_VERSION,
    );
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

// Schema 4 as released: schema 3 plus prefetch origin and cohort on query rows.
const schema4 = schema3.map((statement) =>
  statement
    .replace(
      'accessed_at INTEGER NOT NULL DEFAULT 0,\n    PRIMARY KEY (store_id, id)',
      'accessed_at INTEGER NOT NULL DEFAULT 0,\n    origin TEXT,\n    cohort TEXT,\n    PRIMARY KEY (store_id, id)',
    )
    .replace('PRAGMA user_version = 3', 'PRAGMA user_version = 4'),
);

test('a real schema 4 database is rebuilt as schema 5 with run rows, and drafts are kept', async () => {
  const { sqlite, adapter } = database();
  const identity = scope('schema-4');
  for (const statement of schema4) sqlite.exec(statement);
  assert.equal(sqlite.prepare('PRAGMA user_version').get()?.user_version, 4);
  assert.deepEqual(
    sqlite
      .prepare('PRAGMA table_info(resource_queries)')
      .all()
      .map(({ name }) => name),
    ['store_id', 'id', 'data', 'observed_at', 'bytes', 'accessed_at', 'origin', 'cohort'],
  );
  sqlite
    .prepare('INSERT INTO resource_stores (id, scope_id, metadata, last_used) VALUES (1, ?, ?, 1)')
    .run(resourceStoreScopeId(identity), JSON.stringify({ scope: identity }));
  sqlite
    .prepare("INSERT INTO resource_queries VALUES (1, ?, ?, 1, 17, 2, 'prefetch', 'gate')")
    .run('run.list:{}', JSON.stringify({ runs: [] }));
  sqlite
    .prepare("INSERT INTO resource_content VALUES (1, 'blob', 'held', ?, 3, 'opened', 'gate', 3)")
    .run(new Uint8Array([1, 2, 3]));
  sqlite.exec("CREATE TABLE drafts (text TEXT); INSERT INTO drafts VALUES ('keep draft')");
  const drafts = createDraftStore(createMemoryDraftStorage());
  const draft = await drafts.put({
    scopeId: resourceStoreScopeId(identity),
    slotId: 'slot',
    runId: null,
    path: 'file.ts',
    baseContent: 'base',
    baseHash: null,
    editedContent: 'edited',
    state: 'current',
  });
  const count = (table: string) =>
    sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count;
  const store = await createSqliteResourceStore({ database: adapter, scope: identity });
  try {
    assert.equal(sqlite.prepare('PRAGMA user_version').get()?.user_version, 5);
    assert.deepEqual(
      sqlite
        .prepare('PRAGMA table_info(resource_rows)')
        .all()
        .map(({ name }) => name),
      ['store_id', 'query_id', 'id', 'version', 'projection', 'body', 'bytes'],
    );
    assert.deepEqual(
      sqlite
        .prepare('PRAGMA foreign_key_list(resource_rows)')
        .all()
        .map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete })),
      [
        { table: 'resource_queries', from: 'store_id', to: 'store_id', on_delete: 'CASCADE' },
        { table: 'resource_queries', from: 'query_id', to: 'id', on_delete: 'CASCADE' },
      ],
    );
    assert.equal(await store.getQuery('run.list:{}'), undefined);
    for (const table of ['resource_queries', 'resource_content', 'resource_rows'])
      assert.equal(count(table), 0);
    assert.deepEqual(
      sqlite
        .prepare('SELECT text FROM drafts')
        .all()
        .map(({ text }) => text),
      ['keep draft'],
    );
    assert.deepEqual(await drafts.get(draft), draft);
    assert.equal(sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
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

const runList = 'run.list:{"versions":true}';
const entry = (bytes: number) => ({ id: runList, data: { totalCount: 2 }, observedAt: 1, bytes });
const run = (id: string, version: string, body?: unknown) => ({
  id,
  version,
  projection: { status: 'running', id },
  ...(body === undefined ? {} : { body }),
  bytes: 40,
});

test('run rows merge by id, drop absent bodies, survive putQuery and cascade on deletion', async () => {
  const { sqlite, adapter } = database();
  const store = await createSqliteResourceStore({ database: adapter, scope: scope('rows') });
  const rows = () => sqlite.prepare('SELECT COUNT(*) AS count FROM resource_rows').get()?.count;
  try {
    await store.mergeRows!(runList, {
      entry: entry(120),
      upserts: [run('a', 'v1', { title: 'A' }), run('b', 'v1', null)],
      deletes: [],
    });
    await store.mergeRows!(runList, {
      entry: entry(90),
      upserts: [run('a', 'v2'), run('c', 'v1', { title: 'C' })],
      deletes: ['b', 'unknown'],
    });
    const saved = await store.getRows!(runList);
    assert.deepEqual(saved.entry?.data, { totalCount: 2 });
    assert.deepEqual(
      saved.rows.sort((x, y) => x.id.localeCompare(y.id)),
      [run('a', 'v2'), run('c', 'v1', { title: 'C' })],
    );
    assert.equal('body' in saved.rows[0], false);
    assert.deepEqual(await store.listQueries(), [
      { id: runList, observedAt: 1, accessedAt: 1, bytes: 90 },
    ]);
    assert.equal((await store.byteTotals()).queries, 90);
    await store.mergeRows!(runList, {
      entry: entry(1),
      upserts: [run('n', 'v1', null)],
      deletes: [],
    });
    assert.deepEqual(
      (await store.getRows!(runList)).rows.find((value) => value.id === 'n'),
      run('n', 'v1', null),
    );
    await store.putQuery({ ...entry(5), data: { totalCount: 3 } });
    assert.equal(rows(), 3);
    await store.deleteQuery(runList);
    assert.equal(rows(), 0);
    assert.deepEqual(await store.getRows!(runList), { rows: [] });
    await store.mergeRows!(runList, { entry: entry(1), upserts: [run('a', 'v3')], deletes: [] });
    await store.deleteAll();
    assert.equal(rows(), 0);
    await store.mergeRows!(runList, { entry: entry(1), upserts: [run('late', 'v1')], deletes: [] });
    assert.deepEqual(await store.getRows!(runList), { rows: [] });
    assert.equal(rows(), 0);
    await assert.rejects(
      store.mergeRows!('other', { entry: entry(1), upserts: [], deletes: [] }),
      /own entry/,
    );
  } finally {
    await store.close();
    sqlite.close();
  }
});

test('a failed row merge rolls back the entry, its deletes and its upserts', async () => {
  const { sqlite, adapter } = database();
  const store = await createSqliteResourceStore({ database: adapter, scope: scope('rollback') });
  try {
    await store.mergeRows!(runList, {
      entry: entry(10),
      upserts: [run('a', 'v1', { title: 'A' }), run('b', 'v1', { title: 'B' })],
      deletes: [],
    });
    const before = await store.getRows!(runList);
    const statement = adapter.run;
    let inserts = 0;
    adapter.run = async (sql, params) => {
      if (sql.includes('INSERT INTO resource_rows') && ++inserts === 2)
        throw new Error('disk full');
      await statement(sql, params);
    };
    await assert.rejects(
      store.mergeRows!(runList, {
        entry: entry(99),
        upserts: [run('a', 'v2'), run('c', 'v1', { title: 'C' })],
        deletes: ['b'],
      }),
      /disk full/,
    );
    adapter.run = statement;
    assert.deepEqual(await store.getRows!(runList), before);
    assert.equal(sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally {
    await store.close();
    sqlite.close();
  }
});

test('a hydrate reads the entry and its rows without a merge landing between them', async () => {
  const { sqlite, adapter } = database();
  const store = await createSqliteResourceStore({ database: adapter, scope: scope('hydrate') });
  try {
    await store.mergeRows!(runList, {
      entry: entry(10),
      upserts: [run('a', 'v1', { title: 'A' })],
      deletes: [],
    });
    let entered!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = adapter.all;
    // Hold the entry read: a merge queued now must wait until the rows are read too.
    adapter.all = async (sql, params) => {
      if (sql.includes('FROM resource_queries')) {
        entered();
        await held;
      }
      return query(sql, params);
    };
    const reading = store.getRows!(runList);
    await holding;
    const merging = store.mergeRows!(runList, {
      entry: { ...entry(20), data: { totalCount: 1 } },
      upserts: [],
      deletes: ['a'],
    });
    release();
    const hydrated = await reading;
    await merging;
    adapter.all = query;
    assert.deepEqual(hydrated.entry?.data, { totalCount: 2 });
    assert.deepEqual(
      hydrated.rows.map(({ id, version }) => ({ id, version })),
      [{ id: 'a', version: 'v1' }],
    );
    assert.deepEqual(await store.getRows!(runList), {
      entry: { ...entry(20), data: { totalCount: 1 }, accessedAt: 1 },
      rows: [],
    });
  } finally {
    await store.close();
    sqlite.close();
  }
});

test('deleting a scope from a connection that never opened a store removes its run rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'local-store-rows-'));
  const filename = join(directory, 'resources.sqlite');
  const first = database(new DatabaseSync(filename));
  const store = await createSqliteResourceStore({ database: first.adapter, scope: scope('scope') });
  await store.mergeRows!(runList, { entry: entry(1), upserts: [run('a', 'v1', {})], deletes: [] });
  await store.close();
  first.sqlite.close();
  const second = database(new DatabaseSync(filename, { enableForeignKeyConstraints: false }));
  try {
    await deleteSqliteResourceStoreScope(second.adapter, resourceStoreScopeId(scope('scope')));
    assert.equal(
      second.sqlite.prepare('SELECT COUNT(*) AS count FROM resource_rows').get()?.count,
      0,
    );
  } finally {
    second.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
