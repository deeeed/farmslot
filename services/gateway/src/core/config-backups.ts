// Copies of pool and project configuration files taken before each save. They live in the farm
// home's state, not beside the source, so pool/ and projects/ hold only live configuration.
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';

export type ConfigBackupKind = 'pool' | 'project';

/** Backups kept per source file; older ones are deleted on the next save. */
export const CONFIG_BACKUPS_KEPT = 10;

// Backups this module writes: `<basename>.bak.<YYYYMMDDTHHMMSSmmm>[-<sequence>]`.
const CURRENT = String.raw`(\d{8})T(\d{9})(?:-(\d+))?`;
// The removed writer's stamp, `toISOString().replace(/[:.]/g, '').slice(0, 15)`: dashes kept and
// minute precision, e.g. `2026-11-13T1234`. Exact and anchored, so hand-made names such as
// `.bak.2026-11-13T1234-node` or `.bak.goal` never match.
const LEGACY = String.raw`(\d{4})-(\d{2})-(\d{2})T(\d{4})`;

interface BackupName {
  entry: string;
  /** YYYYMMDDHHMMSSmmm; a legacy name counts from the start of its minute. */
  time: string;
  sequence: number;
  current: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function backupStamp(now: Date): string {
  // 2026-11-13T12:00:00.123Z → 20261113T120000123
  return now.toISOString().replace(/[-:.Z]/g, '');
}

function backupNames(entries: string[], basename: string): BackupName[] {
  const base = escapeRegExp(basename);
  const current = new RegExp(`^${base}\\.bak\\.${CURRENT}$`);
  const legacy = new RegExp(`^${base}\\.bak\\.${LEGACY}$`);
  return entries.flatMap((entry): BackupName[] => {
    const now = current.exec(entry);
    if (now)
      return [{ entry, time: now[1] + now[2], sequence: Number(now[3] ?? 0), current: true }];
    const old = legacy.exec(entry);
    if (old)
      return [
        { entry, time: `${old[1]}${old[2]}${old[3]}${old[4]}00000`, sequence: 0, current: false },
      ];
    return [];
  });
}

/** Move one legacy backup; a pool dir and the farm home can sit on different volumes. */
async function moveFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    // A concurrent save of the same file already moved it: nothing is left to move.
    if (errorCode(error) === 'ENOENT') return;
    if (errorCode(error) !== 'EXDEV') throw error;
  }
  // Two saves of the same file can both reach this copy; whichever finishes second finds the
  // source already gone, after the other save copied and removed it. The move is complete.
  try {
    await copyFile(source, target);
    await unlink(source);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

/**
 * Copy `file` into `<state>/config-backups/<kind>/<name>/` before it is overwritten and return the
 * copy's path. `name` is the pool file basename or the project name, so sources from different
 * directories never share a backup directory. The same file's legacy `<basename>.bak.<stamp>`
 * siblings (the removed writer's minute-precision names) move there too, and only the newest CONFIG_BACKUPS_KEPT copies stay.
 *
 * Every step throws: a failed copy, move or prune fails the save before the source is written.
 * Pruning is not best-effort because a backup directory that cannot be pruned grows without
 * bound, which is the problem this module exists to stop; the operator sees the error instead.
 */
export async function backupConfigFile(
  kind: ConfigBackupKind,
  name: string,
  file: string,
): Promise<string> {
  const basename = path.basename(file);
  const directory = path.join(currentFarmPaths('gateway').state.configBackups, kind, name);
  await mkdir(directory, { recursive: true });

  // Two saves in one millisecond get distinct names instead of overwriting one backup. The
  // sequence starts above the highest one already taken that millisecond, so a name freed by
  // pruning is never reused for a copy that would sort as the oldest.
  const stamp = backupStamp(new Date());
  const prefix = `${basename}.bak.${stamp}`;
  const taken = backupNames(await readdir(directory), basename).filter(
    (item) => item.current && item.time === stamp.replace('T', ''),
  );
  let sequence = taken.length ? Math.max(...taken.map((item) => item.sequence)) + 1 : 0;
  let backup: string;
  for (;;) {
    backup = path.join(directory, sequence === 0 ? prefix : `${prefix}-${sequence}`);
    try {
      await copyFile(file, backup, constants.COPYFILE_EXCL);
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      sequence += 1;
    }
  }

  const sources = path.dirname(file);
  for (const { entry, current } of backupNames(await readdir(sources), basename)) {
    if (!current) await moveFile(path.join(sources, entry), path.join(directory, entry));
  }

  // The copy just taken is always kept, even when it sorts oldest (a clock stepped backwards),
  // alongside the newest of the others.
  const others = backupNames(await readdir(directory), basename)
    .filter((item) => item.entry !== path.basename(backup))
    .sort((a, b) => a.time.localeCompare(b.time) || a.sequence - b.sequence);
  for (const { entry } of others.slice(0, Math.max(0, others.length - (CONFIG_BACKUPS_KEPT - 1)))) {
    try {
      await unlink(path.join(directory, entry));
    } catch (error) {
      // A concurrent save of the same file pruned it first.
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  return backup;
}
