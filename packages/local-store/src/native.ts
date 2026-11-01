import type {
  ResourceStore,
  ResourceStoreScope,
  StoredResourceQueryInfo,
} from '@farmslot/protocol/client-cache';

import {
  createSqliteResourceStore,
  readSqliteResourceQueryInfo,
  readSqliteStoreDiagnostics,
  type ResourceSqliteDatabase,
  type SqliteValue,
} from './sqlite-store.js';

/** The Expo methods used by the adapter, also exercised with real SQLite in conformance. */
export interface ExpoSqliteConnection {
  runAsync(sql: string, params: SqliteValue[]): Promise<unknown>;
  getAllAsync<T>(sql: string, params: SqliteValue[]): Promise<T[]>;
}

export function createExpoSqliteDriver(connection: ExpoSqliteConnection): ResourceSqliteDatabase {
  return {
    async run(sql, params = []) {
      await connection.runAsync(sql, [...params]);
    },
    all: (sql, params = []) => connection.getAllAsync(sql, [...params]),
  };
}

interface NativeDatabase {
  driver: ResourceSqliteDatabase;
  directory: string;
  filename: string;
}

export interface NativeResourceStoreOptions {
  scope: ResourceStoreScope;
  databaseName?: string;
  schemaVersion?: number;
  /** A scope's store was deleted (revoked, or evicted past the store limit), so its files go too. */
  onDeleted?: (scopeId: string) => void;
}

export interface NativeResourceStoreDiagnostics {
  directory: string;
  filename: string;
  integrity: string;
  schemaVersion: number;
  storeCount: number;
}

const databases = new Map<string, Promise<NativeDatabase>>();

async function database(databaseName: string): Promise<NativeDatabase> {
  let pending = databases.get(databaseName);
  if (!pending) {
    pending = (async () => {
      const [sqlite, files] = await Promise.all([
        import('expo-sqlite'),
        import('expo-file-system'),
      ]);
      const directory = new files.Directory(files.Paths.cache, 'farmslot-resource-store');
      directory.create({ idempotent: true, intermediates: true });
      const connection = await sqlite.openDatabaseAsync(databaseName, {}, directory.uri);
      return {
        driver: createExpoSqliteDriver(connection),
        directory: directory.uri,
        filename: databaseName,
      };
    })();
    databases.set(databaseName, pending);
  }
  try {
    return await pending;
  } catch (error) {
    // An unavailable native module or temporary open failure can be retried after a new build/start.
    if (databases.get(databaseName) === pending) databases.delete(databaseName);
    throw error;
  }
}

/** Cache-directory storage is disposable and excluded from device backup. */
export async function createNativeSqliteResourceStore(
  options: NativeResourceStoreOptions,
): Promise<ResourceStore> {
  const opened = await database(options.databaseName ?? 'resources.sqlite');
  return createSqliteResourceStore({
    database: opened.driver,
    scope: options.scope,
    schemaVersion: options.schemaVersion,
    onDeleted: options.onDeleted,
  });
}

export async function nativeResourceStoreDiagnostics(
  databaseName = 'resources.sqlite',
): Promise<NativeResourceStoreDiagnostics> {
  const opened = await database(databaseName);
  return {
    directory: opened.directory,
    filename: opened.filename,
    ...(await readSqliteStoreDiagnostics(opened.driver)),
  };
}

export async function nativeResourceQueryInfo(
  scopeId: string,
  queryId: string,
  databaseName = 'resources.sqlite',
): Promise<StoredResourceQueryInfo | undefined> {
  const opened = await database(databaseName);
  return readSqliteResourceQueryInfo(opened.driver, scopeId, queryId);
}
