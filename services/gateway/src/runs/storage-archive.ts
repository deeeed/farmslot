import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, renameSync } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, readFile, readlink, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { writeAtomicJSON } from '../core/atomic-json.js';

export function runArchiveRoot(): string {
  return process.env.FARMSLOT_RUN_ARCHIVE_ROOT ?? path.join(farmslotHome(), 'run-archive');
}

export interface StorageArchiveEntry {
  source: string;
  staged: string;
  destination: string;
  store: string;
  completedAt?: string;
  verifiedCopy?: Record<string, string>;
  partial?: string;
  state?: 'planned' | 'staged' | 'archived';
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
    const entries = new Map(prior.entries.map((entry) => [entry.destination, entry]));
    const phases = { planned: 0, staged: 1, archived: 2 };
    for (const entry of manifest.entries) {
      const old = entries.get(entry.destination);
      const state =
        phases[old?.state ?? 'planned'] > phases[entry.state ?? 'planned']
          ? old?.state
          : entry.state;
      entries.set(entry.destination, {
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
  const entries: Record<string, string> = {};
  async function visit(file: string): Promise<void> {
    const info = await lstat(file);
    const key = path.relative(root, file);
    const mode = info.mode & 0o777;
    if (info.isSymbolicLink()) entries[key] = `link:${await readlink(file)}`;
    else if (info.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      entries[key] = `${mode}:${hash.digest('hex')}`;
    } else if (info.isDirectory()) {
      entries[key] = `directory:${mode}`;
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name));
    } else throw new Error(`Cannot archive special file ${file}`);
  }
  await visit(root);
  return entries;
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
  if (entry.completedAt) return;
  if (existsSync(entry.staged)) {
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
    const prior = manifest.entries.find((entry) => entry.source === source && !entry.completedAt);
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
  await saveManifest(manifestPath, manifest);
  // Recheck only this pass's selection; old unstarted entries cannot regain ownership.
  if (!beforeStage()) throw new Error(`Run storage became active before archive: ${runId}`);
  const selected = new Set(files.map((file) => path.resolve(file.source)));
  for (const entry of manifest.entries) {
    if (
      !entry.completedAt &&
      selected.has(entry.source) &&
      existsSync(entry.source) &&
      !existsSync(entry.staged)
    ) {
      renameSync(entry.source, entry.staged);
      entry.state = 'staged';
    }
  }
  await saveManifest(manifestPath, manifest);
}

export async function finishStorageArchive(root: string, runId: string): Promise<void> {
  const manifestPath = storageArchiveManifest(root, runId);
  await serializeArchiveOperation(archiveFinishes, manifestPath, async () => {
    if (!existsSync(manifestPath)) return;
    const manifest: StorageArchiveManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const entry of manifest.entries) {
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
