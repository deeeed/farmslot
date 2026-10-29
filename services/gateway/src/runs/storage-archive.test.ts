import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { archiveStoragePaths, resumeStorageArchives } from './storage-archive.js';

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
});
