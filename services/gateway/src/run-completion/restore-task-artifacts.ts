import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, type Run, type RunArtifactBundleRef } from '@farmslot/protocol';
import { readRetainedRunBundle } from '@farmslot/run-bundle';

import { sha256File } from '../core/file-hash.js';
import { assertHeavyWriteRoom } from '../core/heavy-write-room.js';
import { getRun } from '../runs/store.js';

import { retainedRunBundleRef, runBundleStore, withTaskDirWrite } from './retained-artifacts.js';

const PROVENANCE = 'artifacts/harness-provenance.json';
const HANDOFF = 'inputs/handoff.json';
type Bundle = Awaited<ReturnType<typeof readRetainedRunBundle>>;

/** Follow only the digest-verified predecessor recorded by this run's own capture. */
async function predecessor(
  bundle: Bundle,
  runId: string,
): Promise<RunArtifactBundleRef | undefined> {
  const entry = bundle.manifest.runs.find((entry) => entry.originalRunId === runId)!;
  const meta = bundle.manifest.entries[entry.runPath];
  const file = path.join(bundle.directory, entry.runPath);
  if (
    !meta ||
    (await realpath(file)) !== file ||
    (await lstat(file)).size !== meta.bytes ||
    (await sha256File(file)) !== meta.sha256
  )
    throw new Error('Retained predecessor record changed.');
  const record: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(record) || record.id !== runId)
    throw new Error('Retained predecessor run changed.');
  const ref = record.artifactBundle;
  if (ref === undefined) return undefined;
  if (
    !isRecord(ref) ||
    typeof ref.storeId !== 'string' ||
    typeof ref.bundleDigest !== 'string' ||
    typeof ref.taskKey !== 'string' ||
    typeof ref.manifestDigest !== 'string'
  )
    throw new Error('Invalid retained predecessor reference.');
  return {
    storeId: ref.storeId,
    bundleDigest: ref.bundleDigest,
    taskKey: ref.taskKey,
    manifestDigest: ref.manifestDigest,
  };
}

async function sourceBundle(run: Run): Promise<Bundle> {
  const store = await runBundleStore();
  let ref: RunArtifactBundleRef | undefined = retainedRunBundleRef(run);
  let latest: Bundle | undefined;
  const seen = new Set<string>();
  while (ref) {
    if (seen.has(ref.bundleDigest)) throw new Error('Retained predecessor cycle.');
    seen.add(ref.bundleDigest);
    const bundle = await readRetainedRunBundle(store, ref, run.id);
    latest ??= bundle;
    const prefix = `tasks/${ref.taskKey}/`;
    if (bundle.manifest.entries[prefix + PROVENANCE]) {
      // Earlier evidence belongs to this exact frozen task, never to a replacement task.
      const handoff = bundle.manifest.entries[prefix + HANDOFF];
      if (
        !handoff ||
        (await sha256File(path.join(path.dirname(run.taskFile!), HANDOFF))) !== handoff.sha256
      )
        throw new Error('Retained task inputs differ; restoration refused.');
      return bundle;
    }
    ref = await predecessor(bundle, run.id);
  }
  // Legacy tasks without a runtime receipt still restore their latest captured artifacts.
  return latest!;
}

/** Make each directory without traversing a symlink in the mutable task tree. */
async function destinationDirectory(root: string, relative: string): Promise<string> {
  let directory = root;
  for (const segment of relative.split('/').slice(0, -1)) {
    directory = path.join(directory, segment);
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Task artifact directory is redirected.');
  }
  return directory;
}

/** Rehydrate original bytes only; never restore signals, verdict state or overwrite newer files. */
export async function restoreRetainedTaskArtifacts(run: Run): Promise<number> {
  if (!run.taskFile || (!run.artifactBundle && !run.output?.artifactBundle)) return 0;
  const bundle = await sourceBundle(run);
  const entry = bundle.manifest.runs.find((entry) => entry.originalRunId === run.id)!;
  const prefix = `tasks/${entry.taskKey}/`;
  const taskFile = run.taskFile;
  const generation = run.engineState?.generation;
  const assertCurrent = () => {
    const current = getRun(run.id);
    if (
      !current ||
      current.taskFile !== taskFile ||
      current.engineState?.generation !== generation ||
      current.slotId !== run.slotId ||
      current.artifactBundle?.bundleDigest !== run.artifactBundle?.bundleDigest
    )
      throw new Error('Run changed during task artifact restoration.');
  };
  const root = await realpath(path.dirname(taskFile));
  await assertHeavyWriteRoom(root);
  return withTaskDirWrite(root, async () => {
    let copied = 0;
    for (const key of Object.keys(bundle.manifest.entries)) {
      if (!key.startsWith(prefix + 'artifacts/')) continue;
      assertCurrent();
      const relative = key.slice(prefix.length);
      const directory = await destinationDirectory(root, relative);
      const destination = path.join(root, relative);
      const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (existing) {
        if (!existing.isFile()) throw new Error('Task artifact destination is not a file.');
        continue;
      }
      const source = await bundle.resolveEntry(relative);
      const temporary = path.join(directory, `.restore-${randomUUID()}`);
      try {
        await copyFile(source.path, temporary, constants.COPYFILE_FICLONE);
        if ((await sha256File(temporary)) !== source.sha256)
          throw new Error(`Retained artifact bytes changed: ${relative}`);
        await chmod(temporary, 0o600);
        assertCurrent();
        // Atomic, no overwrite: another writer's newer artifact wins.
        await link(temporary, destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        copied += 1;
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return copied;
  });
}
