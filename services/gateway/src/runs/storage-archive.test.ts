import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import {
  archiveStoragePaths,
  finishStorageArchive,
  keepStorageDeletions,
  resumeStorageArchives,
  stageStoragePaths,
} from './storage-archive.js';

test('cross-volume archival preserves bytes, modes, symlinks and interrupted moves', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-archive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const source = path.join(root, 'task');
  await fs.mkdir(archive);
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'script'), 'worker evidence', { mode: 0o755 });
  await fs.symlink('script', path.join(source, 'link'));
  const rename = fs.rename;
  const copy = fs.cp;
  let copied = 0;
  let interrupted = true;
  mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
    if (String(from).includes('.retention-'))
      throw Object.assign(new Error('external volume'), { code: 'EXDEV' });
    return rename(from, to);
  });
  mock.method(fs, 'cp', async (...[from, to, options]: Parameters<typeof fs.cp>) => {
    copied++;
    if (interrupted) throw new Error('external drive disconnected');
    return copy(from, to, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    archiveStoragePaths(archive, 'run-1', [{ source, store: 'task-dirs' }]),
    /disconnected/,
  );
  const manifest = JSON.parse(await fs.readFile(path.join(archive, 'run-1/manifest.json'), 'utf8'));
  const entry = manifest.entries[0];
  assert.equal(await fs.readFile(path.join(entry.staged, 'script'), 'utf8'), 'worker evidence');
  interrupted = false;
  await resumeStorageArchives(archive);
  assert.equal(copied, 2);
  assert.equal(
    await fs.readFile(path.join(entry.destination, 'script'), 'utf8'),
    'worker evidence',
  );
  assert.equal((await fs.stat(path.join(entry.destination, 'script'))).mode & 0o777, 0o755);
  assert.equal(await fs.readlink(path.join(entry.destination, 'link')), 'script');
  await assert.rejects(fs.stat(entry.staged), /ENOENT/);
  // A later restored task has a new generation, leaving the old archived evidence intact.
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'script'), 'restored worker');
  await archiveStoragePaths(archive, 'run-1', [{ source, store: 'task-dirs' }]);
  assert.equal(
    await fs.readFile(path.join(entry.destination, 'script'), 'utf8'),
    'worker evidence',
  );
  const next = JSON.parse(await fs.readFile(path.join(archive, 'run-1/manifest.json'), 'utf8'));
  assert.equal(next.entries.length, 2);
});

test('a late task admission leaves an unstarted archive at its source', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-archive-held-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const source = path.join(root, 'task');
  await fs.mkdir(archive);
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'evidence'), 'still active');
  await assert.rejects(
    archiveStoragePaths(archive, 'held-run', [{ source, store: 'task-dirs' }], () => false),
    /became active/,
  );
  await resumeStorageArchives(archive);
  assert.equal(await fs.readFile(path.join(source, 'evidence'), 'utf8'), 'still active');
  const other = path.join(root, 'unshared');
  await fs.writeFile(other, 'safe to archive');
  await archiveStoragePaths(archive, 'held-run', [{ source: other, store: 'session-archives' }]);
  assert.equal(await fs.readFile(path.join(source, 'evidence'), 'utf8'), 'still active');
});

test('verified source cleanup resumes after a crash removes only one child', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-cleanup-crash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'task'),
    archive = path.join(root, 'archive');
  await fs.mkdir(source);
  await fs.mkdir(archive);
  await fs.writeFile(path.join(source, 'first'), 'first');
  await fs.writeFile(path.join(source, 'second'), 'second');
  const rename = fs.rename,
    remove = fs.rm;
  let interrupted = true;
  mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
    if (String(from).includes('.retention-'))
      throw Object.assign(new Error('cross volume'), { code: 'EXDEV' });
    return rename(from, to);
  });
  mock.method(fs, 'rm', async (...[file, options]: Parameters<typeof fs.rm>) => {
    if (String(file).includes('.retention-') && interrupted) {
      interrupted = false;
      await remove(path.join(String(file), 'first'));
      throw new Error('process stopped during source cleanup');
    }
    return remove(file, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    archiveStoragePaths(archive, 'run-crash', [{ source, store: 'task-dirs' }]),
    /stopped/,
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(archive, 'run-crash/manifest.json'), 'utf8'),
  );
  assert.ok(manifest.entries[0].verifiedCopy);
  assert.deepEqual(await resumeStorageArchives(archive), []);
  for (const name of ['first', 'second'])
    assert.equal(await fs.readFile(path.join(manifest.entries[0].destination, name), 'utf8'), name);
  await assert.rejects(fs.stat(manifest.entries[0].staged), /ENOENT/);
});

test('staging another path while a slow copy runs retains both journal entries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-concurrent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  await fs.mkdir(archive);
  const first = path.join(root, 'first'),
    second = path.join(root, 'second');
  await fs.writeFile(first, 'first');
  await fs.writeFile(second, 'second');
  const rename = fs.rename,
    copy = fs.cp;
  let reached!: () => void, release!: () => void;
  const copying = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
    if (String(from).includes('.retention-'))
      throw Object.assign(new Error('cross volume'), { code: 'EXDEV' });
    return rename(from, to);
  });
  let copies = 0;
  mock.method(fs, 'cp', async (...args: Parameters<typeof fs.cp>) => {
    if (copies++ === 0) {
      reached();
      await released;
    }
    return copy(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    release();
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const pending = archiveStoragePaths(archive, 'run', [
    { source: first, store: 'session-archives' },
  ]);
  await copying;
  try {
    await stageStoragePaths(archive, 'run', [{ source: second, store: 'task-dirs' }]);
  } finally {
    release();
  }
  await pending;
  await finishStorageArchive(archive, 'run');
  const manifest = JSON.parse(await fs.readFile(path.join(archive, 'run/manifest.json'), 'utf8'));
  assert.equal(manifest.entries.length, 2);
  for (const entry of manifest.entries) {
    assert.ok(entry.completedAt);
    assert.equal(await fs.readFile(entry.destination, 'utf8'), path.basename(entry.source));
  }
});

/** A task-pin store with one pin to delete, and the archive root its manifest lives under. */
async function pinStore(t: { after: (fn: () => Promise<void>) => void }, prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const pins = path.join(root, 'pins');
  const source = path.join(pins, 'pin-1');
  await fs.mkdir(archive);
  await fs.mkdir(path.join(source, 'tree'), { recursive: true });
  await fs.writeFile(path.join(source, 'tree', 'file'), 'pinned input');
  const deletion = { source, store: 'task-pins' as const, bytes: 12, root: pins };
  const manifestFile = path.join(archive, 'run-del', 'manifest.json');
  const manifest = async () => JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const detachedSiblings = async () =>
    (await fs.readdir(pins)).filter((name) => name.startsWith('.retention-'));
  return { archive, pins, source, deletion, manifestFile, manifest, detachedSiblings };
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

test('a deletion detaches its source at once and removes it without holding the event loop', async (t) => {
  const store = await pinStore(t, 'storage-delete-async-');
  const remove = fs.rm;
  let reached!: () => void, release!: () => void;
  const removing = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  mock.method(fs, 'rm', async (...[file, options]: Parameters<typeof fs.rm>) => {
    if (String(file).includes('.retention-')) {
      reached();
      await released;
    }
    return remove(file, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    release();
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  let settled = false;
  const pending = stageStoragePaths(store.archive, 'run-del', [], () => true, [store.deletion]);
  void pending.finally(() => (settled = true));
  await Promise.race([removing, pending]);
  // Work scheduled once the removal has begun still runs before the removal ends.
  let otherWork = false;
  setImmediate(() => (otherWork = true));
  await new Promise((resolve) => setImmediate(resolve));
  // The synchronous section is over: the source is gone from its store, the tree is detached.
  assert.equal(await exists(store.source), false);
  const [intent] = (await store.manifest()).entries;
  assert.equal(intent.state, 'deleting');
  assert.equal(path.dirname(intent.detached), store.pins);
  assert.match(path.basename(intent.detached), /^\.retention-/);
  assert.equal(
    await fs.readFile(path.join(intent.detached, 'tree', 'file'), 'utf8'),
    'pinned input',
  );
  assert.equal(otherWork, true, 'other event-loop work ran while the tree was being removed');
  assert.equal(settled, false);
  release();
  await pending;
  assert.equal(await exists(intent.detached), false);
  const [deleted] = (await store.manifest()).entries;
  assert.equal(deleted.state, 'deleted');
  assert.ok(deleted.deletedAt);
  assert.equal(deleted.recovered, undefined);
});

test('an ownership change before deletion detaches nothing', async (t) => {
  const store = await pinStore(t, 'storage-delete-owned-');
  await assert.rejects(
    stageStoragePaths(store.archive, 'run-del', [], () => false, [store.deletion]),
    /became active/,
  );
  assert.equal(await fs.readFile(path.join(store.source, 'tree', 'file'), 'utf8'), 'pinned input');
  assert.deepEqual(await store.detachedSiblings(), []);
  assert.equal((await store.manifest()).entries[0].state, 'kept');
});

test('recovery removes a tree detached before a crash and keeps older intents as they were', async (t) => {
  const store = await pinStore(t, 'storage-delete-recover-');
  const detached = path.join(store.pins, '.retention-crashed');
  await fs.rename(store.source, detached);
  const intent = {
    state: 'deleting',
    store: 'task-pins',
    source: store.source,
    bytes: 12,
    plannedAt: '2026-11-12T00:00:00.000Z',
  };
  await fs.mkdir(path.dirname(store.manifestFile));
  await fs.writeFile(
    store.manifestFile,
    JSON.stringify({ runId: 'run-del', entries: [{ ...intent, detached }] }),
  );
  await finishStorageArchive(store.archive, 'run-del');
  assert.equal(await exists(detached), false);
  const [recovered] = (await store.manifest()).entries;
  assert.equal(recovered.state, 'deleted');
  assert.equal(recovered.recovered, true);

  // An intent written before detaching existed: a missing source is deleted, a present one stays.
  const survivor = path.join(store.pins, 'pin-2');
  await fs.mkdir(survivor);
  await fs.writeFile(
    store.manifestFile,
    JSON.stringify({
      runId: 'run-del',
      entries: [intent, { ...intent, source: survivor }],
    }),
  );
  await finishStorageArchive(store.archive, 'run-del');
  const [gone, present] = (await store.manifest()).entries;
  assert.equal(gone.state, 'deleted');
  assert.equal(gone.recovered, true);
  assert.equal(present.state, 'deleting');
  assert.equal(await exists(survivor), true);
});

test('a removal that fails leaves the intent for recovery to complete', async (t) => {
  const store = await pinStore(t, 'storage-delete-fail-');
  const remove = fs.rm;
  let fail = true;
  mock.method(fs, 'rm', async (...[file, options]: Parameters<typeof fs.rm>) => {
    if (String(file).includes('.retention-') && fail) {
      fail = false;
      throw Object.assign(new Error('volume went away'), { code: 'EIO' });
    }
    return remove(file, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    stageStoragePaths(store.archive, 'run-del', [], () => true, [store.deletion]),
    /volume went away/,
  );
  const [intent] = (await store.manifest()).entries;
  assert.equal(intent.state, 'deleting');
  assert.equal(await exists(store.source), false);
  assert.equal(await exists(intent.detached), true);
  await finishStorageArchive(store.archive, 'run-del');
  assert.equal(await exists(intent.detached), false);
  const [recovered] = (await store.manifest()).entries;
  assert.equal(recovered.state, 'deleted');
  assert.equal(recovered.recovered, true);
});

test('an intent whose tree is already detached is not kept, so recovery removes the tree', async (t) => {
  const store = await pinStore(t, 'storage-delete-keep-');
  const detached = path.join(store.pins, '.retention-left');
  await fs.rename(store.source, detached);
  await fs.mkdir(path.dirname(store.manifestFile));
  await fs.writeFile(
    store.manifestFile,
    JSON.stringify({
      runId: 'run-del',
      entries: [
        {
          state: 'deleting',
          store: 'task-pins',
          source: store.source,
          bytes: 12,
          plannedAt: '2026-11-12T00:00:00.000Z',
          detached,
        },
      ],
    }),
  );
  await keepStorageDeletions(store.archive, 'run-del', 'holds its slot');
  assert.equal((await store.manifest()).entries[0].state, 'deleting');
  await finishStorageArchive(store.archive, 'run-del');
  assert.equal(await exists(detached), false);
  assert.equal((await store.manifest()).entries[0].state, 'deleted');
});

test('an intent whose source is still in place becomes kept when it is no longer eligible', async (t) => {
  const store = await pinStore(t, 'storage-delete-kept-');
  // A crash before the rename: the detached path is recorded but nothing was moved.
  await fs.mkdir(path.dirname(store.manifestFile));
  await fs.writeFile(
    store.manifestFile,
    JSON.stringify({
      runId: 'run-del',
      entries: [
        {
          state: 'deleting',
          store: 'task-pins',
          source: store.source,
          bytes: 12,
          plannedAt: '2026-11-12T00:00:00.000Z',
          detached: path.join(store.pins, '.retention-never-moved'),
        },
      ],
    }),
  );
  await keepStorageDeletions(store.archive, 'run-del', 'holds its slot');
  const [kept] = (await store.manifest()).entries;
  assert.equal(kept.state, 'kept');
  assert.equal(kept.reason, 'holds its slot');
  assert.equal(await fs.readFile(path.join(store.source, 'tree', 'file'), 'utf8'), 'pinned input');
});

/** A gate: `entered` resolves when the gated call arrives, `open()` lets it continue. */
function gate() {
  let arrived!: () => void, open!: () => void;
  const entered = new Promise<void>((resolve) => (arrived = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { entered, opened, arrived, open };
}

/** A staged archive entry needing a finish, for manifests that must also hold deletion intents. */
async function stagedArchiveEntry(store: Awaited<ReturnType<typeof pinStore>>) {
  const evidence = path.join(path.dirname(store.pins), 'evidence');
  await fs.writeFile(evidence, 'session evidence');
  await stageStoragePaths(store.archive, 'run-del', [{ source: evidence, store: 'task-dirs' }]);
  const [entry] = (await store.manifest()).entries;
  return { evidence, entry };
}

test('recovery overlapping a staging turn leaves no detached tree behind', async (t) => {
  const store = await pinStore(t, 'storage-delete-overlap-');
  // A deletion journaled earlier, before its rename (a crash, or a held turn): source in place.
  const detached = path.join(store.pins, '.retention-overlap');
  await fs.mkdir(path.dirname(store.manifestFile));
  await fs.writeFile(
    store.manifestFile,
    JSON.stringify({
      runId: 'run-del',
      entries: [
        {
          state: 'deleting',
          store: 'task-pins',
          source: store.source,
          bytes: 12,
          plannedAt: '2026-11-12T00:00:00.000Z',
          detached,
        },
      ],
    }),
  );
  const remove = fs.rm;
  const recovering = gate();
  let calls = 0;
  mock.method(fs, 'rm', async (...[file, options]: Parameters<typeof fs.rm>) => {
    if (String(file) !== detached) return remove(file, options);
    if (calls++ === 0) {
      // Recovery's removal finds nothing yet and is held before it marks anything.
      await remove(file, options);
      recovering.arrived();
      await recovering.opened;
      return;
    }
    if (calls === 2) throw Object.assign(new Error('volume went away'), { code: 'EIO' });
    return remove(file, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    recovering.open();
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const finish = finishStorageArchive(store.archive, 'run-del');
  await recovering.entered;
  // While recovery is held, staging renames the source to the journaled path and fails to remove it.
  await assert.rejects(
    stageStoragePaths(store.archive, 'run-del', [], () => true, [store.deletion]),
    /volume went away/,
  );
  recovering.open();
  await finish;
  const [intent] = (await store.manifest()).entries;
  assert.equal(intent.state, 'deleting');
  assert.equal(intent.detached, detached);
  assert.equal(await exists(detached), true, 'the detached tree is still journaled, not orphaned');
  await finishStorageArchive(store.archive, 'run-del');
  assert.equal(await exists(detached), false);
  assert.equal((await store.manifest()).entries[0].state, 'deleted');
});

test('a finish started before a staging turn cannot write a stale entry over its intent', async (t) => {
  const store = await pinStore(t, 'storage-delete-stale-');
  const { entry } = await stagedArchiveEntry(store);
  // The pin was kept by an earlier pass; this pass deletes it.
  const manifest = await store.manifest();
  manifest.entries.push({
    state: 'kept',
    store: 'task-pins',
    source: store.source,
    bytes: 12,
    plannedAt: '2026-11-12T00:00:00.000Z',
    reason: 'holds its slot',
  });
  await fs.writeFile(store.manifestFile, JSON.stringify(manifest));
  const rename = fs.rename;
  const remove = fs.rm;
  const finishing = gate();
  const removing = gate();
  mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
    if (String(from) === entry.staged) {
      finishing.arrived();
      await finishing.opened;
    }
    return rename(from, to);
  });
  mock.method(fs, 'rm', async (...[file, options]: Parameters<typeof fs.rm>) => {
    if (String(file).startsWith(path.join(store.pins, '.retention-'))) {
      removing.arrived();
      await removing.opened;
    }
    return remove(file, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    finishing.open();
    removing.open();
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  // The finish holds its copy of the manifest (pin kept) while it moves the archive entry.
  const finish = finishStorageArchive(store.archive, 'run-del');
  await finishing.entered;
  // Staging journals the deletion and detaches the pin while the finish is held, then removes.
  const stage = stageStoragePaths(store.archive, 'run-del', [], () => true, [store.deletion]);
  await removing.entered;
  finishing.open();
  await finish;
  const pin = (await store.manifest()).entries.find(
    (candidate: { source: string }) => candidate.source === store.source,
  );
  assert.equal(pin.state, 'deleting', 'the journaled intent is on disk while its tree is removed');
  assert.match(path.basename(pin.detached), /^\.retention-/);
  removing.open();
  await stage;
  const deleted = (await store.manifest()).entries.find(
    (candidate: { source: string }) => candidate.source === store.source,
  );
  assert.equal(deleted.state, 'deleted');
  assert.equal(await exists(deleted.detached), false);
});

test('staging and recovery of different runs do not wait for each other', async (t) => {
  const store = await pinStore(t, 'storage-delete-independent-');
  const { entry } = await stagedArchiveEntry(store);
  const rename = fs.rename;
  const finishing = gate();
  mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
    if (String(from) === entry.staged) {
      finishing.arrived();
      await finishing.opened;
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => {
    finishing.open();
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const finish = finishStorageArchive(store.archive, 'run-del');
  await finishing.entered;
  // Another run's deletion completes while this run's finish is held.
  await stageStoragePaths(store.archive, 'other-run', [], () => true, [store.deletion]);
  assert.equal(await exists(store.source), false);
  finishing.open();
  await finish;
});

test('a detached tree that cannot be removed does not stop the other entries of its manifest', async (t) => {
  const store = await pinStore(t, 'storage-delete-isolated-');
  await stagedArchiveEntry(store);
  const detached = path.join(store.pins, '.retention-stuck');
  await fs.rename(store.source, detached);
  const manifest = await store.manifest();
  manifest.entries.unshift({
    state: 'deleting',
    store: 'task-pins',
    source: store.source,
    bytes: 12,
    plannedAt: '2026-11-12T00:00:00.000Z',
    detached,
  });
  await fs.writeFile(store.manifestFile, JSON.stringify(manifest));
  const remove = fs.rm;
  mock.method(fs, 'rm', async (...[file, options]: Parameters<typeof fs.rm>) => {
    if (String(file) === detached)
      throw Object.assign(new Error('read-only subdirectory'), { code: 'EACCES' });
    return remove(file, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(finishStorageArchive(store.archive, 'run-del'), /read-only subdirectory/);
  const [intent, archived] = (await store.manifest()).entries;
  assert.equal(intent.state, 'deleting');
  assert.equal(archived.state, 'archived', 'the archive entry after it was finished');
  assert.equal(await fs.readFile(archived.destination, 'utf8'), 'session evidence');
});

test('a finish over runs archived earlier rewrites no manifest', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-settled-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  await fs.mkdir(archive);
  const sources = ['first', 'second', 'third'].map((name) => path.join(root, name));
  for (const source of sources) await fs.writeFile(source, path.basename(source));
  await archiveStoragePaths(
    archive,
    'run-settled',
    sources.map((source) => ({ source, store: 'session-archives' })),
  );
  const manifestFile = path.join(archive, 'run-settled', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  assert.ok(manifest.entries.every((entry: { completedAt?: string }) => entry.completedAt));
  const rename = fs.rename;
  let writes = 0;
  mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
    if (String(to) === manifestFile) writes++;
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  // Every retention pass resumes every archived run: a settled one must cost no write.
  await finishStorageArchive(archive, 'run-settled');
  assert.deepEqual(await resumeStorageArchives(archive), []);
  assert.equal(writes, 0, 'the manifest of a settled run is not rewritten');
  assert.deepEqual(JSON.parse(await fs.readFile(manifestFile, 'utf8')), manifest);
});
