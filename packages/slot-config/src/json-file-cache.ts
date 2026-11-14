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
  /** Text this process wrote, parsed on the first read that needs it. */
  text?: string;
  value?: unknown;
}

/** Parsed config documents by path: a fixed set of project, settings and status files. */
const files = new Map<string, CachedJsonFile>();

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
  if (cached?.trusted && sameStamp(cached.stamp, stamp)) {
    if (cached.text !== undefined) {
      cached.value = deepFreeze(JSON.parse(cached.text));
      delete cached.text;
    }
    return cached.value;
  }
  // Stamp before reading: content that changes during the read is stored under the older stamp,
  // so the next call sees a new stamp and reads it again.
  files.delete(file);
  const value = deepFreeze(JSON.parse(await readFile(file, 'utf8')));
  files.set(file, { stamp, trusted: settled(stamp, Date.now()), value });
  return value;
}

/**
 * Record text this process just committed to `file`, with the stat of the inode it renamed into
 * place, so the next read parses it without reading the file. The writer must have checked that
 * nobody changed that inode between its write and `stats`.
 */
export function rememberJsonFile(file: string, stats: BigIntStats, text: string): void {
  files.set(file, { stamp: stampOf(stats), trusted: true, text });
}
