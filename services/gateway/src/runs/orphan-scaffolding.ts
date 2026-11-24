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
const COLLECTION_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  const bySlot = new Map<string, string[]>();
  let pending = 0;
  for (const slot of await directories(options.scaffoldingRoot)) {
    if (!/^[A-Za-z0-9_-]+$/.test(slot)) continue;
    for (const name of await directories(path.join(options.scaffoldingRoot, slot))) {
      // Only names release writes: a staged move's `.retention-<generation>` sibling is not one.
      if (!COLLECTION_NAME.test(name)) continue;
      const source = path.join(options.scaffoldingRoot, slot, name);
      const at = await completedAt(source);
      if (at === undefined || now - at < options.maxAgeMs) continue;
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), source]);
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
  for (const [slot, sources] of bySlot) {
    const key = `${ARCHIVE_KEY_PREFIX}${slot}`;
    try {
      // Measured before the move, from the source still in place.
      const files = await Promise.all(
        sources.map(async (source) => ({ source, bytes: await diskBytes(source) })),
      );
      await stageStoragePaths(
        options.archiveRoot,
        key,
        sources.map((source) => ({ source, store: 'slot-scaffolding' })),
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
