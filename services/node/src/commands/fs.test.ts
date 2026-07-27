import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fsDelete, fsHash, fsList, fsRead, fsReadBase64, fsWrite, fsWriteFiles } from './fs.js';

test('fsList classifies symlinked directories as directories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-'));
  const linkedDir = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-link-'));
  await mkdir(path.join(root, 'dir'));
  await writeFile(path.join(root, 'file.txt'), 'ok', 'utf-8');
  await symlink(linkedDir, path.join(root, 'linked-dir'));

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(linkedDir, { recursive: true, force: true });
  });

  const result = await fsList({ root, relPath: '.' });
  assert.deepEqual(result.entries, [
    { name: 'dir', type: 'directory' },
    { name: 'linked-dir', type: 'directory' },
    { name: 'file.txt', type: 'file', size: 2 },
  ]);
});

test('fsHash streams a sha256 digest for remote artifact scans', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-hash-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const content = 'same-size artifact content\n';
  const filePath = path.join(root, 'artifact.txt');
  await writeFile(filePath, content, 'utf-8');

  const result = await fsHash({ root, relPath: 'artifact.txt' });
  assert.deepEqual(result, {
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
  });
});

test('fsWriteFiles materializes a nested bundle with parent dirs and modes', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-bundle-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const result = await fsWriteFiles({
    root: path.dirname(base),
    relPath: path.basename(base),
    files: [
      {
        path: 'scripts/helper.sh',
        content: Buffer.from('#!/bin/sh\n').toString('base64'),
        mode: 0o755,
      },
      { path: 'manifest.txt', content: Buffer.from('ok').toString('base64') },
    ],
  });

  assert.deepEqual(result, { ok: true, count: 2 });
  assert.equal(await readFile(path.join(base, 'scripts/helper.sh'), 'utf-8'), '#!/bin/sh\n');
  assert.equal((await stat(path.join(base, 'scripts/helper.sh'))).mode & 0o777, 0o755);
  assert.equal(await readFile(path.join(base, 'manifest.txt'), 'utf-8'), 'ok');
});

test('fsWriteFiles refuses an entry path that escapes baseDir', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-escape-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  await assert.rejects(
    fsWriteFiles({
      root: path.dirname(base),
      relPath: path.basename(base),
      files: [{ path: '../escape.sh', content: Buffer.from('x').toString('base64') }],
    }),
    /escaping baseDir/,
  );
});

test('node fs refuses reads and writes inside .git', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-git-'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'config'), 'secret');
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(fsRead({ root, relPath: '.git/config' }), /\.git/);
  await assert.rejects(fsWrite({ root, relPath: '.git/config', content: 'corrupt' }), /\.git/);
});

test('node fs refuses final-component symlinks but keeps symlinked directories usable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-links-'));
  await mkdir(path.join(root, 'real-dir'));
  await writeFile(path.join(root, 'real-dir', 'file.txt'), 'original');
  await symlink('real-dir/file.txt', path.join(root, 'file-link'));
  await symlink('real-dir', path.join(root, 'dir-link'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(fsRead({ root, relPath: 'file-link' }), /Final-component symlink/);
  await assert.rejects(
    fsWrite({ root, relPath: 'file-link', content: 'changed' }),
    /Final-component symlink/,
  );
  assert.equal((await fsRead({ root, relPath: 'dir-link/file.txt' })).content, 'original');
  assert.equal(
    (await fsList({ root, relPath: '.' })).entries.find((entry) => entry.name === 'dir-link')?.type,
    'directory',
  );
});

test('node fs delete refuses .git and final-component symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-delete-'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'target'), 'ok');
  await symlink('target', path.join(root, 'link'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(fsDelete({ root, relPath: '.git' }), /\.git/);
  await assert.rejects(fsDelete({ root, relPath: 'link' }), /Final-component symlink/);
});

test('node fs.readBase64 enforces maxBytes before reading content', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-limit-'));
  await writeFile(path.join(root, 'large.bin'), Buffer.alloc(32, 1));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    fsReadBase64({ root, relPath: 'large.bin', maxBytes: 16 }),
    /exceeds maximum size/,
  );
});
