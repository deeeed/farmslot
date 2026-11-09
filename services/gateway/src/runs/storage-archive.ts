import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { inventory } from '@farmslot/protocol/node/tree-fingerprint';

import { writeAtomicJSON } from '../core/atomic-json.js';
import { assertHeavyWriteRoom } from '../core/heavy-write-room.js';
import { assertStorageVolumePresent } from '../core/storage-volume.js';

export function runArchiveRoot(): string {
  return currentFarmPaths('gateway').data.runArchive;
}

interface ArchivedStorageEntry {
  source: string;
  staged: string;
  destination: string;
  store: string;
  completedAt?: string;
  verifiedCopy?: Record<string, string>;
  partial?: string;
  state?: 'planned' | 'staged' | 'archived';
}

interface StorageDeletionEntry {
  store: 'task-pins' | 'review-workspaces';
  source: string;
  bytes: number;
}

interface DeletingStorageEntry extends StorageDeletionEntry {
  state: 'deleting';
  plannedAt: string;
}

export interface DeletedStorageEntry extends StorageDeletionEntry {
  state: 'deleted';
  // Older completed deletions predate the intent journal.
  plannedAt?: string;
  deletedAt: string;
  recovered?: true;
}

interface KeptStorageEntry extends StorageDeletionEntry {
  state: 'kept';
  plannedAt: string;
  reason: string;
}

export type StorageArchiveEntry =
  | ArchivedStorageEntry
  | DeletingStorageEntry
  | DeletedStorageEntry
  | KeptStorageEntry;

function isArchiveEntry(entry: StorageArchiveEntry): entry is ArchivedStorageEntry {
  return entry.state !== 'deleting' && entry.state !== 'deleted' && entry.state !== 'kept';
}

function manifestKey(entry: StorageArchiveEntry): string {
  return isArchiveEntry(entry)
    ? entry.destination
    : `delete:${JSON.stringify([entry.store, entry.source])}`;
}

export interface StorageDeletion {
  source: string;
  store: DeletedStorageEntry['store'];
  bytes: number;
  root: string;
}

interface StorageArchiveManifest {
  runId: string;
  entries: StorageArchiveEntry[];
}

const manifestWrites = new Map<string, Promise<void>>();
const archiveFinishes = new Map<string, Promise<void>>();

function serializeArchiveOperation(
  queue: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<void>,
): Promise<void> {
  // A failed move remains journaled; later callers must be able to retry it.
  const current = (queue.get(key) ?? Promise.resolve()).then(operation, operation);
  queue.set(key, current);
  return current.finally(() => {
    if (queue.get(key) === current) queue.delete(key);
  });
}

/** A real write, not access(W_OK): catches macOS removable-volume privacy failures. */
export async function assertArchiveRoot(root: string): Promise<void> {
  assertStorageVolumePresent(root);
  if (!path.isAbsolute(root) || !(await lstat(root)).isDirectory())
    throw new Error(`Run archive root must be an existing absolute directory: ${root}`);
  const probe = path.join(root, `.gateway-write-probe-${randomUUID()}`);
  try {
    const file = await open(probe, 'wx', 0o600);
    try {
      await file.writeFile('run archive write probe');
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    throw new Error(`Gateway cannot write run archive root ${root}`, { cause: error });
  } finally {
    if (existsSync(probe)) await rm(probe);
  }
}

export function storageArchiveManifest(root: string, runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid archive run id');
  return path.join(root, runId, 'manifest.json');
}

async function saveManifest(file: string, manifest: StorageArchiveManifest): Promise<void> {
  await serializeArchiveOperation(manifestWrites, file, async () => {
    const prior: StorageArchiveManifest = existsSync(file)
      ? JSON.parse(await readFile(file, 'utf8'))
      : { runId: manifest.runId, entries: [] };
    const key = manifestKey;
    const entries = new Map(prior.entries.map((entry) => [key(entry), entry]));
    const phases = { planned: 0, staged: 1, archived: 2 };
    for (const entry of manifest.entries) {
      const old = entries.get(key(entry));
      if (!isArchiveEntry(entry)) {
        // A concurrent archive save must not put an already resolved intent back in flight.
        if (
          old &&
          !isArchiveEntry(old) &&
          old.plannedAt === entry.plannedAt &&
          old.state !== 'deleting' &&
          entry.state === 'deleting'
        )
          continue;
        entries.set(key(entry), entry);
        continue;
      }
      if (old && !isArchiveEntry(old)) throw new Error('Archive entry key collision');
      const state =
        phases[old?.state ?? 'planned'] > phases[entry.state ?? 'planned']
          ? old?.state
          : entry.state;
      entries.set(key(entry), {
        ...old,
        ...entry,
        state,
        completedAt: entry.completedAt ?? old?.completedAt,
        verifiedCopy: entry.verifiedCopy ?? old?.verifiedCopy,
        partial: entry.partial ?? old?.partial,
      });
    }
    await writeAtomicJSON(file, { runId: manifest.runId, entries: [...entries.values()] });
  });
}

/** Compare file bytes, permission bits and literal symlink targets without following links. */
async function fingerprint(root: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(await inventory(root)).map(([key, entry]) => [
      key,
      entry.kind === 'link'
        ? `link:${entry.digest}`
        : entry.kind === 'directory'
          ? `directory:${entry.mode}`
          : `${entry.mode}:${entry.digest}`,
    ]),
  );
}

async function syncTree(file: string): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory())
    for (const name of await readdir(file)) await syncTree(path.join(file, name));
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function finishEntry(entry: StorageArchiveEntry, save: () => Promise<void>): Promise<void> {
  if (!isArchiveEntry(entry) || entry.completedAt) return;
  if (existsSync(entry.staged)) {
    await assertHeavyWriteRoom(path.dirname(entry.destination));
    await mkdir(path.dirname(entry.destination), { recursive: true });
    try {
      // A retry must never overwrite an earlier archive copy.
      if (!existsSync(entry.destination)) await rename(entry.staged, entry.destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      const expected = await fingerprint(entry.staged);
      const partial = entry.partial ?? `${entry.destination}.copy`;
      entry.partial = partial;
      await save();
      await cp(entry.staged, partial, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        errorOnExist: false,
        force: true,
      });
      if (
        !isDeepStrictEqual(expected, await fingerprint(partial)) ||
        !isDeepStrictEqual(expected, await fingerprint(entry.staged))
      )
        throw new Error(`Archive copy verification failed; source retained at ${entry.staged}`);
      await rename(partial, entry.destination);
    }
    if (existsSync(entry.staged)) {
      const source = await fingerprint(entry.staged);
      const destination = await fingerprint(entry.destination);
      if (entry.verifiedCopy) {
        if (
          !isDeepStrictEqual(destination, entry.verifiedCopy) ||
          !Object.entries(source).every(
            ([file, identity]) => entry.verifiedCopy?.[file] === identity,
          )
        )
          throw new Error(`Verified archive changed; remaining source retained at ${entry.staged}`);
      } else {
        if (!isDeepStrictEqual(source, destination))
          throw new Error(`Archive differs; source retained at ${entry.staged}`);
        await syncTree(entry.destination);
        const directory = await open(path.dirname(entry.destination), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        entry.verifiedCopy = destination;
        await save(); // Recovery may now safely finish a partially completed source cleanup.
      }
      await rm(entry.staged, { recursive: true });
    }
  }
  if (!existsSync(entry.destination))
    throw new Error(`Archive source and destination missing: ${entry.source}`);
  entry.completedAt = new Date().toISOString();
  entry.state = 'archived';
}

/** Journal before staging; an interrupted move resumes from the same source/destination. */
export async function stageStoragePaths(
  root: string,
  runId: string,
  files: { source: string; store: string }[],
  beforeStage: () => boolean = () => true,
  deletions: StorageDeletion[] = [],
): Promise<void> {
  const manifestPath = storageArchiveManifest(root, runId);
  const manifest: StorageArchiveManifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, 'utf8'))
    : { runId, entries: [] };
  for (const file of files) {
    const source = path.resolve(file.source);
    if (source === root || source.startsWith(root + path.sep) || root.startsWith(source + path.sep))
      throw new Error('Archive cannot overlap its source');
    if (!existsSync(source)) continue;
    const relative = source.slice(path.parse(source).root.length);
    const prior = manifest.entries.find(
      (entry) => isArchiveEntry(entry) && entry.source === source && !entry.completedAt,
    );
    if (prior) continue;
    // Keep every generation if a restored task is later archived again.
    const generation = randomUUID();
    manifest.entries.push({
      source,
      store: file.store,
      state: 'planned',
      staged: path.join(path.dirname(source), `.retention-${generation}`),
      destination: path.join(root, runId, generation, relative),
    });
  }
  for (const file of deletions) {
    const source = path.resolve(file.source);
    const prior = manifest.entries.find(
      (entry) => !isArchiveEntry(entry) && entry.store === file.store && entry.source === source,
    );
    if (prior?.state === 'deleting') continue;
    const intent: DeletingStorageEntry = {
      state: 'deleting',
      store: file.store,
      source,
      bytes: file.bytes,
      plannedAt: new Date().toISOString(),
    };
    if (prior) manifest.entries[manifest.entries.indexOf(prior)] = intent;
    else manifest.entries.push(intent);
  }
  // writeAtomicJSON fsyncs both the intent file and its parent before removal.
  await saveManifest(manifestPath, manifest);
  // Recheck only this pass's selection; old unstarted entries cannot regain ownership.
  if (!beforeStage()) {
    await keepStorageDeletions(root, runId, 'retention eligibility changed before deletion');
    throw new Error(`Run storage became active before archive: ${runId}`);
  }
  const selected = new Set(files.map((file) => path.resolve(file.source)));
  for (const entry of manifest.entries) {
    if (
      isArchiveEntry(entry) &&
      !entry.completedAt &&
      selected.has(entry.source) &&
      existsSync(entry.source) &&
      !existsSync(entry.staged)
    ) {
      renameSync(entry.source, entry.staged);
      entry.state = 'staged';
    }
  }
  // Stay synchronous from the ownership re-check through staging and deletion.
  for (const file of deletions) {
    const source = path.resolve(file.source);
    const storeRoot = path.resolve(file.root);
    const relative = path.relative(storeRoot, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`Deletion must be inside its store: ${source}`);
    // rm does not follow child symlinks, but a symlink in a parent would escape
    // the store before rm sees the exact path. Refuse those parents too.
    for (let parent = path.dirname(source); ; parent = path.dirname(parent)) {
      if (lstatSync(parent).isSymbolicLink())
        throw new Error(`Deletion parent is a symlink: ${parent}`);
      if (parent === storeRoot) break;
    }
    rmSync(source, { recursive: true, force: true });
    const index = manifest.entries.findIndex(
      (entry) =>
        entry.state === 'deleting' && entry.store === file.store && entry.source === source,
    );
    const intent = manifest.entries[index];
    if (intent?.state !== 'deleting') throw new Error(`Deletion intent missing: ${source}`);
    manifest.entries[index] = { ...intent, state: 'deleted', deletedAt: new Date().toISOString() };
  }
  await saveManifest(manifestPath, manifest);
}

/** Resolve intents rejected by the normal retention eligibility checks. */
export async function keepStorageDeletions(
  root: string,
  runId: string,
  reason: string,
  eligible: StorageDeletion[] = [],
): Promise<void> {
  const file = storageArchiveManifest(root, runId);
  if (!existsSync(file)) return;
  const manifest: StorageArchiveManifest = JSON.parse(await readFile(file, 'utf8'));
  const changes: KeptStorageEntry[] = manifest.entries.flatMap((entry) =>
    entry.state === 'deleting' &&
    !eligible.some(
      (selected) =>
        selected.store === entry.store && path.resolve(selected.source) === entry.source,
    )
      ? [{ ...entry, state: 'kept', reason }]
      : [],
  );
  if (changes.length) await saveManifest(file, { runId, entries: changes });
}

export async function finishStorageArchive(root: string, runId: string): Promise<void> {
  const manifestPath = storageArchiveManifest(root, runId);
  await serializeArchiveOperation(archiveFinishes, manifestPath, async () => {
    if (!existsSync(manifestPath)) return;
    const manifest: StorageArchiveManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const entry of manifest.entries) {
      if (entry.state === 'deleting') {
        // Recovery never removes a surviving source; the next eligibility turn decides.
        if (!lstatSync(entry.source, { throwIfNoEntry: false })) {
          const recovered: DeletedStorageEntry = {
            ...entry,
            state: 'deleted',
            deletedAt: new Date().toISOString(),
            recovered: true,
          };
          manifest.entries[manifest.entries.indexOf(entry)] = recovered;
          await saveManifest(manifestPath, { runId, entries: [recovered] });
        }
        continue;
      }
      if (!isArchiveEntry(entry)) continue;
      if (!entry.completedAt && !existsSync(entry.staged) && !existsSync(entry.destination))
        continue;
      await finishEntry(entry, () => saveManifest(manifestPath, manifest));
      await saveManifest(manifestPath, manifest);
    }
  });
}

export async function archiveStoragePaths(
  root: string,
  runId: string,
  files: { source: string; store: string }[],
  beforeStage: () => boolean = () => true,
): Promise<void> {
  await stageStoragePaths(root, runId, files, beforeStage);
  await finishStorageArchive(root, runId);
}

export async function resumeStorageArchives(root: string): Promise<string[]> {
  const failed: string[] = [];
  for (const name of await readdir(root)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const manifest = storageArchiveManifest(root, name);
    if (!existsSync(manifest)) continue;
    try {
      await finishStorageArchive(root, name);
    } catch (error) {
      failed.push(name);
      console.error(
        `[run-retention] archive ${name} failed; journal and source retained: ${(error as Error).message}`,
      );
    }
  }
  return failed;
}
