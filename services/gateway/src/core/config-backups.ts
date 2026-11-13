// Copies of pool and project configuration files taken before each save. They live in the farm
// home's state, not beside the source, so pool/ and projects/ hold only live configuration.
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';

export type ConfigBackupKind = 'pool' | 'project';

/** Backups kept per source file; older ones are deleted on the next save. */
export const CONFIG_BACKUPS_KEPT = 10;

// `<basename>.bak.<YYYYMMDDTHHMMSS>`, then milliseconds and a same-millisecond sequence number
// for backups this module writes. The legacy writer used only the second-precision stamp.
const STAMP = String.raw`(\d{8}T\d{6})(\d{3})?(?:-(\d+))?`;

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

/** Move one legacy backup; a pool dir and the farm home can sit on different volumes. */
async function moveFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    // A concurrent save of the same file already moved it: nothing is left to move.
    if (errorCode(error) === 'ENOENT') return;
    if (errorCode(error) !== 'EXDEV') throw error;
    await copyFile(source, target);
    await unlink(source);
  }
}

/**
 * Copy `file` into `<state>/config-backups/<kind>/<name>/` before it is overwritten and return the
 * copy's path. `name` is the pool file basename or the project name, so sources from different
 * directories never share a backup directory. The same file's legacy `<basename>.bak.<stamp>`
 * siblings move there too, and only the newest CONFIG_BACKUPS_KEPT copies stay.
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
  // sequence starts past the copies already taken that millisecond, so a name freed by pruning
  // is never reused for a copy that would then sort as the oldest and be pruned at once.
  const prefix = `${basename}.bak.${backupStamp(new Date())}`;
  let sequence = (await readdir(directory)).filter(
    (entry) => entry === prefix || entry.startsWith(`${prefix}-`),
  ).length;
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

  const legacy = new RegExp(`^${escapeRegExp(basename)}\\.bak\\.\\d{8}T\\d{6}$`);
  for (const entry of await readdir(path.dirname(file))) {
    if (legacy.test(entry))
      await moveFile(path.join(path.dirname(file), entry), path.join(directory, entry));
  }

  const owned = new RegExp(`^${escapeRegExp(basename)}\\.bak\\.${STAMP}$`);
  const backups = (await readdir(directory))
    .map((entry) => ({ entry, match: owned.exec(entry) }))
    .filter((item): item is { entry: string; match: RegExpExecArray } => item.match !== null)
    .sort(
      (a, b) =>
        a.match[1].localeCompare(b.match[1]) ||
        (a.match[2] ?? '').localeCompare(b.match[2] ?? '') ||
        Number(a.match[3] ?? 0) - Number(b.match[3] ?? 0),
    );
  for (const { entry } of backups.slice(0, -CONFIG_BACKUPS_KEPT)) {
    try {
      await unlink(path.join(directory, entry));
    } catch (error) {
      // A concurrent save of the same file pruned it first.
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  return backup;
}
