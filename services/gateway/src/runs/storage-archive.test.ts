import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import {
  archiveStoragePaths,
  finishStorageArchive,
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
