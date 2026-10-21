import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';

import type { ResourceSqliteDatabase } from './sqlite-store.js';

export function createWasmSqliteDriver(database: Database): ResourceSqliteDatabase {
  return {
    async run(sql, params = []) {
      database.exec({ sql, bind: params });
    },
    async all<T>(sql: string, params = []) {
      const rows: Record<string, SqlValue>[] = [];
      database.exec({ sql, bind: params, rowMode: 'object', resultRows: rows });
      return rows as T[];
    },
  };
}
