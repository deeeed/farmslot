import type { BigIntStats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

import { deepFreeze, isRacyStamp } from '@farmslot/protocol';

/** One version of a file. A rewrite changes it; an atomic rename also changes the inode. */
interface JsonFileStamp {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface CachedJsonFile {
  stamp: JsonFileStamp;
  /** The file had settled when it was stamped, so an equal stamp later means equal content. */
  trusted: boolean;
  value: unknown;
}

/** Parsed config documents by path, least recently read first. Bounded because pack paths are
 * revision-specific and an old revision's files are never read again. */
const files = new Map<string, CachedJsonFile>();
const MAX_FILES = 256;

const stampOf = (stats: BigIntStats): JsonFileStamp => ({
  ino: stats.ino,
  size: stats.size,
  mtimeNs: stats.mtimeNs,
  ctimeNs: stats.ctimeNs,
});

const sameStamp = (a: JsonFileStamp, b: JsonFileStamp): boolean =>
  a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function settled(stamp: JsonFileStamp, now: number): boolean {
  const changedNs = stamp.mtimeNs > stamp.ctimeNs ? stamp.mtimeNs : stamp.ctimeNs;
  return !isRacyStamp(Number(changedNs / 1_000_000n), now);
}

/**
 * The parsed JSON of `file`, deep-frozen and shared: each file version is read and parsed once.
 * Every call stats the file, so a rewrite or replace is seen by the next read. A file changed too
 * recently for its stamp to be trusted is read again (isRacyStamp). Errors are the ones readFile
 * and JSON.parse throw, and a failed read leaves nothing cached. Callers must not mutate the
 * result; copy what they change.
 */
export async function readJsonFile(file: string): Promise<unknown> {
  let stats: BigIntStats;
  try {
    stats = await stat(file, { bigint: true });
  } catch (error) {
    files.delete(file);
    // Throw what the uncached read throws: its error names the open, not a stat.
    await readFile(file, 'utf8');
    throw error;
  }
  const stamp = stampOf(stats);
  const cached = files.get(file);
  files.delete(file);
  if (cached?.trusted && sameStamp(cached.stamp, stamp)) {
    files.set(file, cached);
    return cached.value;
  }
  // Stamp and judge it before reading: content that changes during the read is stored under the
  // older stamp, so the next call sees a new stamp; a stalled read cannot make a racy stamp settle.
  const trusted = settled(stamp, Date.now());
  const value = deepFreeze(JSON.parse(await readFile(file, 'utf8')));
  files.delete(file);
  files.set(file, { stamp, trusted, value });
  if (files.size > MAX_FILES) files.delete(files.keys().next().value!);
  return value;
}
