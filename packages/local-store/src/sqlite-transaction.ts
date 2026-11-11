import type { ResourceSqliteDatabase } from './sqlite-store.js';

/** A failed cleanup leaves connection state uncertain, even if the primary code is unavailable. */
export class SqliteTransactionError extends AggregateError {
  readonly resultCode?: number;

  constructor(error: unknown, rollbackError: unknown) {
    const message = (value: unknown) => (value instanceof Error ? value.message : String(value));
    super([error, rollbackError], `${message(error)}; rollback failed: ${message(rollbackError)}`, {
      cause: error,
    });
    this.name = 'SqliteTransactionError';
    const code = error && typeof error === 'object' ? Reflect.get(error, 'resultCode') : undefined;
    if (typeof code === 'number') this.resultCode = code;
  }
}

/** BEGIN failures own no transaction; failed statements/COMMIT may already have rolled it back. */
export async function sqliteTransaction(
  database: ResourceSqliteDatabase,
  write: () => Promise<void>,
): Promise<void> {
  await database.run('BEGIN IMMEDIATE');
  try {
    await write();
    await database.run('COMMIT');
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch (rollbackError) {
      // Keep the primary failure and its code. Retire this connection instead of
      // treating SQLite's automatic rollback as a healthy, retryable statement error.
      throw new SqliteTransactionError(error, rollbackError);
    }
    throw error;
  }
}
