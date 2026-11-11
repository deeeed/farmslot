import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createSqliteResourceStore,
  type ResourceSqliteDatabase,
  type SqliteValue,
} from '../src/sqlite-store.js';
import { storeWorkerFailure } from '../src/worker-protocol.js';

for (const phase of ['initialize', 'mergeRows'] as const) {
  test(`${phase} preserves the failure that auto-rolled back its transaction`, async () => {
    const sqlite = new DatabaseSync(':memory:');
    const original = Object.assign(new Error('SQLITE_IOERR: interrupted page write'), {
      resultCode: 10,
    });
    let armed = phase === 'initialize';
    let rollbackError: unknown;
    const database: ResourceSqliteDatabase = {
      async run(sql, params = []) {
        if (
          armed &&
          (sql.startsWith('CREATE TABLE') || sql.includes('INSERT INTO resource_rows'))
        ) {
          armed = false;
          // SQLite can auto-rollback on IOERR. Reproduce that actual connection
          // state before surfacing the primary VFS failure to the store.
          sqlite.exec('ROLLBACK');
          throw original;
        }
        try {
          sqlite.prepare(sql).run(...params);
        } catch (error) {
          if (sql === 'ROLLBACK') rollbackError = error;
          throw error;
        }
      },
      async all<T>(sql: string, params: readonly SqliteValue[] = []) {
        return sqlite.prepare(sql).all(...params) as T[];
      },
    };
    try {
      const open = () =>
        createSqliteResourceStore({
          database,
          scope: {
            gatewayUrl: 'ws://rollback.invalid',
            principalId: 'proof',
            principalGeneration: 0,
          },
        });
      const work =
        phase === 'initialize'
          ? open()
          : (async () => {
              const store = await open();
              armed = true;
              await store.mergeRows!('runs', {
                entry: { id: 'runs', data: {}, observedAt: 1, bytes: 2 },
                upserts: [{ id: 'run', version: '1', projection: {}, bytes: 2 }],
                deletes: [],
              });
            })();
      await assert.rejects(work, (error: unknown) => {
        assert.ok(rollbackError instanceof Error);
        assert.match(rollbackError.message, /cannot rollback - no transaction is active/);
        const response = storeWorkerFailure(1, error);
        assert.ok('ok' in response && !response.ok);
        assert.equal(
          response.resultCode,
          10,
          'rollback must not hide the primary SQLite error code',
        );
        assert.equal(
          response.fatal,
          true,
          'the failed worker must be retired so reopening can recover',
        );
        return true;
      });
      assert.equal(sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    } finally {
      sqlite.close();
    }
  });
}

// Uncertain cleanup without an SDK resultCode must also retire the worker.
test('failed rollback without an error code is fatal and retains both failures', async () => {
  const { sqliteTransaction, SqliteTransactionError } =
    await import('../src/sqlite-transaction.js');
  const primary = new Error('write failed');
  const cleanup = new Error('rollback failed');
  const database: ResourceSqliteDatabase = {
    async run(sql) {
      if (sql === 'ROLLBACK') throw cleanup;
    },
    async all<T>() {
      return [] as T[];
    },
  };
  await assert.rejects(
    sqliteTransaction(database, async () => {
      throw primary;
    }),
    (error: unknown) => {
      assert.ok(error instanceof SqliteTransactionError);
      assert.equal(error.cause, primary);
      assert.equal(error.rollbackError, cleanup);
      const response = storeWorkerFailure(7, error);
      assert.ok('ok' in response && !response.ok && response.fatal);
      return true;
    },
  );
});

test('ordinary statement errors rollback atomically; BEGIN failures never rollback', async () => {
  const { sqliteTransaction } = await import('../src/sqlite-transaction.js');
  const sqlite = new DatabaseSync(':memory:');
  const calls: string[] = [];
  const database: ResourceSqliteDatabase = {
    async run(sql, params = []) {
      calls.push(sql);
      sqlite.prepare(sql).run(...params);
    },
    async all<T>() {
      return [] as T[];
    },
  };
  try {
    sqlite.exec('CREATE TABLE atomic (value TEXT UNIQUE)');
    await assert.rejects(
      sqliteTransaction(database, async () => {
        await database.run("INSERT INTO atomic VALUES ('one')");
        await database.run("INSERT INTO atomic VALUES ('one')");
      }),
      /UNIQUE constraint failed/,
    );
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM atomic').get()?.count, 0);
    assert.equal(calls.at(-1), 'ROLLBACK');
    sqlite.exec('BEGIN');
    calls.length = 0;
    await assert.rejects(
      sqliteTransaction(database, async () => {
        assert.fail('BEGIN failed');
      }),
      /within a transaction/,
    );
    assert.deepEqual(calls, ['BEGIN IMMEDIATE']);
    sqlite.exec('ROLLBACK');
  } finally {
    sqlite.close();
  }
});
