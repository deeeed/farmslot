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
  let otherWork = false;
  setImmediate(() => (otherWork = true));
  let settled = false;
  const pending = stageStoragePaths(store.archive, 'run-del', [], () => true, [store.deletion]);
  void pending.finally(() => (settled = true));
  await Promise.race([removing, pending]);
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
