import {
  type ResourceStore,
  type ResourceStoreMetadata,
  type ResourceStoreScope,
  resourceStoreScopeId,
  type StoredResourceContentInfo,
  type StoredResourceQuery,
  type StoredResourceQueryInfo,
} from '@farmslot/protocol/client-cache';

export type SqliteValue = string | number | null | Uint8Array;
export interface ResourceSqliteDatabase {
  run(sql: string, params?: readonly SqliteValue[]): Promise<void>;
  all<T>(sql: string, params?: readonly SqliteValue[]): Promise<T[]>;
}

export interface SqliteResourceStoreOptions {
  database: ResourceSqliteDatabase;
  scope: ResourceStoreScope;
  schemaVersion?: number;
  /** Platform owner broadcasts deletion to other tabs before accepting another read. */
  onDeleted?: (scopeId: string) => void;
}

export const RESOURCE_STORE_SCHEMA_VERSION = 3;
export const RESOURCE_STORE_LIMIT = 5;

export interface ResourceSqliteDiagnostics {
  integrity: string;
  schemaVersion: number;
  storeCount: number;
}

interface StoreRow {
  id: number;
  scope_id: string;
}
interface MetadataRow {
  metadata: string | null;
}
interface QueryRow extends StoredResourceQueryInfo {
  data: string;
}
interface ContentRow extends StoredResourceContentInfo {
  // A native driver may bind an empty array as NULL.
  data: Uint8Array | null;
}
const contentColumns =
  'c.kind, c.id, c.data, c.bytes, c.origin, c.cohort, c.accessed_at AS accessedAt';
interface TotalsRow {
  bytes: number;
  content: number;
}
interface VersionRow {
  user_version: number;
}
interface StoreHandle {
  seal(): void;
}

class DatabaseOwner {
  private tail: Promise<void> = Promise.resolve();
  private readonly handles = new Map<number, Set<StoreHandle>>();
  private schemaVersion?: number;

  constructor(readonly database: ResourceSqliteDatabase) {}

  serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // The returned result reports the failure. Later calls still need a usable serial executor.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  attach(id: number, handle: StoreHandle): void {
    const handles = this.handles.get(id) ?? new Set<StoreHandle>();
    handles.add(handle);
    this.handles.set(id, handles);
  }

  detach(id: number, handle: StoreHandle): void {
    const handles = this.handles.get(id);
    handles?.delete(handle);
    if (!handles?.size) this.handles.delete(id);
  }

  seal(id: number): void {
    const handles = this.handles.get(id);
    this.handles.delete(id);
    for (const handle of handles ?? []) handle.seal();
  }

  async initialize(version: number): Promise<void> {
    if (this.schemaVersion === version) return;
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('Invalid resource store schema version');
    const db = this.database;
    await db.run('PRAGMA foreign_keys = ON');
    const current = (await db.all<VersionRow>('PRAGMA user_version'))[0]?.user_version ?? 0;
    await db.run('BEGIN IMMEDIATE');
    try {
      if (current !== version) {
        for (const id of this.handles.keys()) this.seal(id);
        await db.run('DROP TABLE IF EXISTS resource_content_aliases');
        await db.run('DROP TABLE IF EXISTS resource_content');
        await db.run('DROP TABLE IF EXISTS resource_queries');
        await db.run('DROP TABLE IF EXISTS resource_stores');
      }
      await db.run(`CREATE TABLE IF NOT EXISTS resource_stores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id TEXT NOT NULL UNIQUE,
        metadata TEXT,
        last_used INTEGER NOT NULL
      )`);
      await db.run(`CREATE TABLE IF NOT EXISTS resource_queries (
        store_id INTEGER NOT NULL REFERENCES resource_stores(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (store_id, id)
      )`);
      await db.run(`CREATE TABLE IF NOT EXISTS resource_content (
        store_id INTEGER NOT NULL REFERENCES resource_stores(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        data BLOB,
        bytes INTEGER NOT NULL,
        origin TEXT NOT NULL,
        cohort TEXT NOT NULL,
        accessed_at INTEGER NOT NULL,
        PRIMARY KEY (store_id, kind, id)
      )`);
      await db.run(`CREATE TABLE IF NOT EXISTS resource_content_aliases (
        store_id INTEGER NOT NULL,
        alias TEXT NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        PRIMARY KEY (store_id, alias),
        FOREIGN KEY (store_id, kind, id)
          REFERENCES resource_content(store_id, kind, id) ON DELETE CASCADE
      )`);
      await db.run(`PRAGMA user_version = ${version}`);
      await db.run('COMMIT');
      this.schemaVersion = version;
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
  }
}

const owners = new WeakMap<ResourceSqliteDatabase, DatabaseOwner>();

export async function readSqliteStoreDiagnostics(
  database: ResourceSqliteDatabase,
): Promise<ResourceSqliteDiagnostics> {
  const owner = owners.get(database) ?? new DatabaseOwner(database);
  owners.set(database, owner);
  return owner.serial(async () => {
    const tables = await database.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resource_stores'",
    );
    return {
      integrity:
        (await database.all<{ integrity_check: string }>('PRAGMA integrity_check'))[0]
          ?.integrity_check ?? 'unavailable',
      schemaVersion: (await database.all<VersionRow>('PRAGMA user_version'))[0]?.user_version ?? 0,
      storeCount: tables.length
        ? ((
            await database.all<{ count: number }>('SELECT COUNT(*) AS count FROM resource_stores')
          )[0]?.count ?? 0)
        : 0,
    };
  });
}

/** Read metadata behind the same queue as writes, without opening another SQL connection. */
export async function readSqliteResourceQueryInfo(
  database: ResourceSqliteDatabase,
  scopeId: string,
  queryId: string,
): Promise<StoredResourceQueryInfo | undefined> {
  const owner = owners.get(database) ?? new DatabaseOwner(database);
  owners.set(database, owner);
  return owner.serial(
    async () =>
      (
        await database.all<StoredResourceQueryInfo>(
          'SELECT q.id, q.observed_at AS observedAt, q.bytes FROM resource_queries q JOIN resource_stores s ON s.id = q.store_id WHERE s.scope_id = ? AND q.id = ?',
          [scopeId, queryId],
        )
      )[0],
  );
}

/** A memory-only tab can revoke a scope held by the database owner. */
export async function deleteSqliteResourceStoreScope(
  database: ResourceSqliteDatabase,
  scopeId: string,
): Promise<void> {
  const owner = owners.get(database) ?? new DatabaseOwner(database);
  owners.set(database, owner);
  await owner.serial(async () => {
    const present = await database.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resource_stores'",
    );
    if (!present.length) return;
    // Cascade to content blobs even when this connection never opened a store.
    await database.run('PRAGMA foreign_keys = ON');
    const rows = await database.all<StoreRow>(
      'SELECT id, scope_id FROM resource_stores WHERE scope_id = ?',
      [scopeId],
    );
    for (const row of rows) {
      owner.seal(row.id);
      await database.run('DELETE FROM resource_stores WHERE id = ?', [row.id]);
    }
  });
}

/** One database contains at most five scoped stores. Each reopened store gets a new row incarnation. */
export async function createSqliteResourceStore(
  options: SqliteResourceStoreOptions,
): Promise<ResourceStore> {
  const owner = owners.get(options.database) ?? new DatabaseOwner(options.database);
  owners.set(options.database, owner);
  const db = owner.database;
  const scopeId = resourceStoreScopeId(options.scope);
  const row = await owner.serial(async () => {
    await owner.initialize(options.schemaVersion ?? RESOURCE_STORE_SCHEMA_VERSION);
    await db.run(
      `INSERT INTO resource_stores (scope_id, last_used)
      VALUES (?, (SELECT COALESCE(MAX(last_used), 0) + 1 FROM resource_stores))
      ON CONFLICT (scope_id) DO UPDATE SET last_used = excluded.last_used`,
      [scopeId],
    );
    const current = (
      await db.all<StoreRow>('SELECT id, scope_id FROM resource_stores WHERE scope_id = ?', [
        scopeId,
      ])
    )[0];
    if (!current) throw new Error('Resource store creation returned no incarnation');
    const evicted = await db.all<StoreRow>(
      `SELECT id, scope_id FROM resource_stores
      ORDER BY last_used DESC, id DESC LIMIT -1 OFFSET ?`,
      [RESOURCE_STORE_LIMIT],
    );
    for (const old of evicted) {
      owner.seal(old.id);
      await db.run('DELETE FROM resource_stores WHERE id = ?', [old.id]);
      options.onDeleted?.(old.scope_id);
    }
    return current;
  });
  let deleted = false;
  let closed = false;
  const listeners = new Set<() => void>();
  const handle: StoreHandle = {
    seal() {
      if (deleted) return;
      deleted = true;
      for (const listener of listeners) listener();
    },
  };
  owner.attach(row.id, handle);
  const available = () => !closed && !deleted;

  async function read<T>(operation: () => Promise<T>, absent: T): Promise<T> {
    return owner.serial(async () => {
      if (!available()) return absent;
      const present = await db.all<StoreRow>(
        'SELECT id, scope_id FROM resource_stores WHERE id = ?',
        [row.id],
      );
      if (!present.length) {
        owner.seal(row.id);
        return absent;
      }
      await db.run(
        `UPDATE resource_stores SET last_used =
        (SELECT COALESCE(MAX(last_used), 0) + 1 FROM resource_stores) WHERE id = ?`,
        [row.id],
      );
      const result = await operation();
      return available() ? result : absent;
    });
  }

  function readContent(sql: string, values: readonly SqliteValue[]) {
    return read(async () => {
      const saved = (await db.all<ContentRow>(sql, values))[0];
      return saved ? { ...saved, data: new Uint8Array(saved.data ?? []) } : undefined;
    }, undefined);
  }

  function write(sql: string, values: readonly SqliteValue[]): Promise<void> {
    return owner.serial(async () => {
      if (available()) {
        await db.run(sql, values);
        await db.run(
          `UPDATE resource_stores SET last_used =
          (SELECT COALESCE(MAX(last_used), 0) + 1 FROM resource_stores) WHERE id = ?`,
          [row.id],
        );
      }
    });
  }

  return {
    persistent: true,
    get deleted() {
      return deleted;
    },
    onDeleted(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getMetadata() {
      return read(async () => {
        const saved = (
          await db.all<MetadataRow>('SELECT metadata FROM resource_stores WHERE id = ?', [row.id])
        )[0];
        return saved?.metadata ? (JSON.parse(saved.metadata) as ResourceStoreMetadata) : undefined;
      }, undefined);
    },
    setMetadata(metadata) {
      return write('UPDATE resource_stores SET metadata = ? WHERE id = ?', [
        JSON.stringify(metadata),
        row.id,
      ]);
    },
    getQuery<T>(id: string) {
      return read(async () => {
        const saved = (
          await db.all<QueryRow>(
            `SELECT id, data, observed_at AS observedAt, accessed_at AS accessedAt, bytes
          FROM resource_queries WHERE store_id = ? AND id = ?`,
            [row.id, id],
          )
        )[0];
        if (!saved) return undefined;
        return {
          id: saved.id,
          data: JSON.parse(saved.data) as T,
          observedAt: saved.observedAt,
          bytes: saved.bytes,
          accessedAt: saved.accessedAt || saved.observedAt,
        };
      }, undefined);
    },
    putQuery<T>(entry: StoredResourceQuery<T>) {
      return write(
        `INSERT INTO resource_queries (store_id, id, data, observed_at, bytes, accessed_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM resource_stores WHERE id = ?)
        ON CONFLICT (store_id, id) DO UPDATE SET data = excluded.data,
          observed_at = excluded.observed_at, bytes = excluded.bytes, accessed_at = excluded.accessed_at`,
        [
          row.id,
          entry.id,
          JSON.stringify(entry.data),
          entry.observedAt,
          entry.bytes,
          entry.accessedAt ?? entry.observedAt,
          row.id,
        ],
      );
    },
    touchQuery(id, accessedAt) {
      return write('UPDATE resource_queries SET accessed_at = ? WHERE store_id = ? AND id = ?', [
        accessedAt,
        row.id,
        id,
      ]);
    },
    deleteQuery(id) {
      return write('DELETE FROM resource_queries WHERE store_id = ? AND id = ?', [row.id, id]);
    },
    listQueries() {
      return read(
        () =>
          db.all<StoredResourceQueryInfo>(
            `SELECT id, observed_at AS observedAt, accessed_at AS accessedAt, bytes
        FROM resource_queries WHERE store_id = ?`,
            [row.id],
          ),
        [],
      );
    },
    hasContent(key) {
      return read(
        async () =>
          (
            await db.all(
              'SELECT 1 AS present FROM resource_content WHERE store_id = ? AND kind = ? AND id = ?',
              [row.id, key.kind, key.id],
            )
          ).length > 0,
        false,
      );
    },
    getContent(key) {
      return readContent(
        `SELECT ${contentColumns} FROM resource_content c
        WHERE c.store_id = ? AND c.kind = ? AND c.id = ?`,
        [row.id, key.kind, key.id],
      );
    },
    putContentAlias(alias, key) {
      return write(
        `INSERT INTO resource_content_aliases (store_id, alias, kind, id)
        SELECT ?, ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM resource_content WHERE store_id = ? AND kind = ? AND id = ?)
        ON CONFLICT (store_id, alias) DO UPDATE SET kind = excluded.kind, id = excluded.id`,
        [row.id, alias, key.kind, key.id, row.id, key.kind, key.id],
      );
    },
    getContentByAlias(alias) {
      return readContent(
        `SELECT ${contentColumns} FROM resource_content_aliases a
        JOIN resource_content c ON c.store_id = a.store_id AND c.kind = a.kind AND c.id = a.id
        WHERE a.store_id = ? AND a.alias = ?`,
        [row.id, alias],
      );
    },
    putContent(entry) {
      return write(
        `INSERT INTO resource_content (store_id, kind, id, data, bytes, origin, cohort, accessed_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM resource_stores WHERE id = ?)
        ON CONFLICT (store_id, kind, id) DO UPDATE SET data = excluded.data, bytes = excluded.bytes,
          origin = excluded.origin, cohort = excluded.cohort, accessed_at = excluded.accessed_at`,
        [
          row.id,
          entry.kind,
          entry.id,
          entry.data,
          entry.bytes,
          entry.origin,
          entry.cohort,
          entry.accessedAt,
          row.id,
        ],
      );
    },
    touchContent(key, accessedAt, origin) {
      return write(
        `UPDATE resource_content SET accessed_at = ?, origin = COALESCE(?, origin)
        WHERE store_id = ? AND kind = ? AND id = ?`,
        [accessedAt, origin ?? null, row.id, key.kind, key.id],
      );
    },
    deleteContent(key) {
      return write('DELETE FROM resource_content WHERE store_id = ? AND kind = ? AND id = ?', [
        row.id,
        key.kind,
        key.id,
      ]);
    },
    listContent() {
      return read(
        () =>
          db.all<StoredResourceContentInfo>(
            `SELECT kind, id, bytes, origin, cohort, accessed_at AS accessedAt
        FROM resource_content WHERE store_id = ?`,
            [row.id],
          ),
        [],
      );
    },
    byteTotals() {
      return read(
        async () => {
          const totals = (
            await db.all<TotalsRow>(
              `SELECT
              (SELECT COALESCE(SUM(bytes), 0) FROM resource_queries WHERE store_id = ?) AS bytes,
              (SELECT COALESCE(SUM(bytes), 0) FROM resource_content WHERE store_id = ?) AS content`,
              [row.id, row.id],
            )
          )[0];
          return { queries: totals?.bytes ?? 0, content: totals?.content ?? 0 };
        },
        { queries: 0, content: 0 },
      );
    },
    deleteAll() {
      if (deleted) return Promise.resolve();
      handle.seal();
      owner.seal(row.id);
      options.onDeleted?.(scopeId);
      return owner.serial(() => db.run('DELETE FROM resource_stores WHERE id = ?', [row.id]));
    },
    async close() {
      closed = true;
      listeners.clear();
      owner.detach(row.id, handle);
    },
  };
}
