// cache — per-user records the harness can always rebuild, keyed by what they
// were computed from. A missing or corrupt record is a miss; a record the
// filesystem refuses to store only costs the next command the same work again.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// FARMSLOT_RECIPE_CACHE_DIR, else the XDG cache home.
export function recipeCacheDir(): string {
  const override = process.env.FARMSLOT_RECIPE_CACHE_DIR?.trim();
  if (override) return path.resolve(override);
  const home = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(home, 'farmslot', 'recipe-cli');
}

/** The record file for `key` (any JSON-serializable identity) in the `kind` cache. */
export function cacheRecordPath(kind: string, key: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(key)).digest('hex');
  return path.join(recipeCacheDir(), kind, `${digest}.json`);
}

export function readCacheRecord(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // A torn or hand-edited record is rebuilt and overwritten by the caller.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']);

export function writeCacheRecord(file: string, record: unknown): void {
  // Unique per write, so two writes of one record in a process never share a staged file.
  const staged = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(staged, JSON.stringify(record));
    // rename() replaces the record atomically, so a concurrent reader sees the old or the new one.
    fs.renameSync(staged, file);
  } catch (error) {
    // The caller already holds the value; an unwritable cache only loses the reuse.
    if (UNWRITABLE.has((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
}
