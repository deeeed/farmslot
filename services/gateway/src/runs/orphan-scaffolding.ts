import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { diskBytes } from './retention.js';
import {
  assertArchiveRoot,
  finishStorageArchive,
  stageStoragePaths,
  storageArchiveManifest,
} from './storage-archive.js';

export interface OrphanScaffoldingResult {
  archived: { source: string; bytes: number }[];
  /** Collections old enough to move that are still in place. */
  pending: number;
  /** Why nothing moved this pass, such as an unmounted archive volume. */
  skipped?: string;
  failed: string[];
}

const ARCHIVE_KEY_PREFIX = 'slot-scaffolding-';

async function directories(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir, { withFileTypes: true });
    return names.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Age from manifest.json, which slot release writes last; no manifest means not complete. */
async function completedAt(collection: string): Promise<number | undefined> {
  try {
    const manifest = await lstat(path.join(collection, 'manifest.json'));
    return manifest.isFile() ? manifest.mtimeMs : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Slot release collects scaffolding under `<runs>/slot-scaffolding/<slot>/<collection>` when no
 * run owns the release; nothing reads it afterwards. Collections older than the retention window
 * move to the run archive, one restore manifest per slot. Nothing is deleted.
 */
export async function archiveOrphanSlotScaffolding(options: {
  scaffoldingRoot: string;
  archiveRoot: string;
  maxAgeMs: number;
  now?: number;
}): Promise<OrphanScaffoldingResult> {
  const now = options.now ?? Date.now();
  const bySlot = new Map<string, { source: string; bytes: number }[]>();
  let pending = 0;
  for (const slot of await directories(options.scaffoldingRoot)) {
    if (!/^[A-Za-z0-9_-]+$/.test(slot)) continue;
    for (const name of await directories(path.join(options.scaffoldingRoot, slot))) {
      const source = path.join(options.scaffoldingRoot, slot, name);
      const at = await completedAt(source);
      if (at === undefined || now - at < options.maxAgeMs) continue;
      const files = bySlot.get(slot) ?? [];
      files.push({ source, bytes: await diskBytes(source) });
      bySlot.set(slot, files);
      pending++;
    }
  }
  const result: OrphanScaffoldingResult = { archived: [], pending, failed: [] };
  if (!pending) return result;
  try {
    await assertArchiveRoot(options.archiveRoot);
  } catch (error) {
    const { message, cause } = error as Error;
    result.skipped = cause instanceof Error ? `${message}: ${cause.message}` : message;
    return result;
  }
  for (const [slot, files] of bySlot) {
    const key = `${ARCHIVE_KEY_PREFIX}${slot}`;
    try {
      await stageStoragePaths(
        options.archiveRoot,
        key,
        files.map(({ source }) => ({ source, store: 'slot-scaffolding' })),
      );
      await finishStorageArchive(options.archiveRoot, key);
      result.archived.push(...files);
      result.pending -= files.length;
    } catch (error) {
      result.failed.push(
        `${storageArchiveManifest(options.archiveRoot, key)}: ${(error as Error).message}`,
      );
    }
  }
  return result;
}
