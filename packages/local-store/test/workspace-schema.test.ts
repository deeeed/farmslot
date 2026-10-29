import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createSqliteResourceStore,
  RESOURCE_STORE_SCHEMA_VERSION,
  type ResourceSqliteDatabase,
} from '../src/sqlite-store.js';

test('access recency schema mismatch rebuilds cache and fences former handles while leaving drafts alone', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const database: ResourceSqliteDatabase = {
    async run(sql, params = []) {
      sqlite.prepare(sql).run(...params);
    },
    async all<T>(sql: string, params = []) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
  };
  const scope = { gatewayUrl: 'ws://schema.invalid', principalId: 'owner', principalGeneration: 0 };
  const old = await createSqliteResourceStore({
    database,
    scope,
    schemaVersion: RESOURCE_STORE_SCHEMA_VERSION - 1,
  });
  await old.putQuery({ id: 'saved', data: 'old bytes', observedAt: 1, bytes: 9 });
  sqlite.exec("CREATE TABLE drafts (text TEXT); INSERT INTO drafts VALUES ('keep draft')");
  const current = await createSqliteResourceStore({ database, scope });
  try {
    assert.equal(await current.getQuery('saved'), undefined);
    await old.putQuery({ id: 'late', data: 'former handle', observedAt: 2, bytes: 13 });
    await old.touchQuery?.('saved', 3);
    assert.deepEqual(await current.listQueries(), []);
    assert.deepEqual(
      sqlite
        .prepare('SELECT text FROM drafts')
        .all()
        .map((row) => row.text),
      ['keep draft'],
    );
    await current.putQuery({ id: 'fresh', data: 'bytes', observedAt: 4, bytes: 5 });
    await current.touchQuery?.('fresh', 10);
    const fresh = await current.getQuery('fresh');
    assert.equal(fresh?.observedAt, 4);
    assert.equal(fresh?.accessedAt, 10);
  } finally {
    await current.close();
    await old.close();
    sqlite.close();
  }
});
