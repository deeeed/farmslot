import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fsDelete, fsExists, fsHash, fsList, fsRead, fsStat, fsWrite, fsWriteFiles } from './fs.js';

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

test('fsHash streams a multi-chunk sha256 digest for remote artifact scans', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-hash-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const content = Buffer.alloc(256 * 1024 + 17, 'x');
  const filePath = path.join(root, 'artifact.txt');
  await writeFile(filePath, content);

  const result = await fsHash({ root, relPath: path.basename(filePath) });
  assert.deepEqual(result, {
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
  });
});

test('fsStat probes unreadable files without following final symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-stat-'));
  const filePath = path.join(root, 'unreadable.txt');
  const linkPath = path.join(root, 'link.txt');
  await writeFile(filePath, 'content');
  await symlink(filePath, linkPath);
  await chmod(filePath, 0o000);
  t.after(() => rm(root, { recursive: true, force: true }));

  const fileStat = await fsStat({ root, relPath: 'unreadable.txt' });
  assert.deepEqual(
    { size: fileStat.size, isFile: fileStat.isFile, isDirectory: fileStat.isDirectory },
    { size: 7, isFile: true, isDirectory: false },
  );
  // mtimeMs backs the gateway's bounded stale-attachment sweep.
  assert.ok(fileStat.mtimeMs > 0);
  const linkStat = await fsStat({ root, relPath: 'link.txt' });
  assert.deepEqual(
    { size: linkStat.size, isFile: linkStat.isFile, isDirectory: linkStat.isDirectory },
    { size: Buffer.byteLength(filePath), isFile: false, isDirectory: false },
  );
});

test('fsExists preserves probe semantics but propagates confinement denials', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-exists-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await fsExists({ root, relPath: 'missing.txt' }), { exists: false });
  await assert.rejects(fsExists({ root, relPath: '../escape.txt' }), /outside root/);
});

test('fsWriteFiles materializes a nested bundle with parent dirs and modes', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-bundle-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const result = await fsWriteFiles({
    root: base,
    relPath: '.',
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
      root: base,
      relPath: '.',
      files: [{ path: '../escape.sh', content: Buffer.from('x').toString('base64') }],
    }),
    /outside root/,
  );
});

test('fsRead and fsWrite refuse final-component symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-symlink-'));
  const target = path.join(root, 'target.txt');
  const link = path.join(root, 'link.txt');
  await writeFile(target, 'original', 'utf-8');
  await symlink(target, link);
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(fsRead({ root, relPath: 'link.txt' }), /final-component symlink/);
  await assert.rejects(
    fsWrite({ root, relPath: 'link.txt', content: 'changed' }),
    /final-component symlink/,
  );
  assert.equal(await readFile(target, 'utf-8'), 'original');
});

test('node fs operations refuse ordinary paths inside .git', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-git-'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'config'), 'safe', 'utf-8');
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(fsRead({ root, relPath: '.git/config' }), /Access to \.git/);
  await assert.rejects(
    fsWrite({ root, relPath: '.git/config', content: 'corrupt' }),
    /Access to \.git/,
  );
  await assert.rejects(fsDelete({ root, relPath: '.git/config' }), /Access to \.git/);
  assert.equal(await readFile(path.join(root, '.git', 'config'), 'utf-8'), 'safe');
});

test('fsReadChunk returns a bounded base64 slice and eof', async (t) => {
  const { fsReadChunk } = await import('./fs.js');
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-chunk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = Buffer.alloc(100, 'a');
  await writeFile(path.join(root, 'blob.bin'), content);

  const first = await fsReadChunk({ root, relPath: 'blob.bin', offset: 0, length: 40 });
  assert.equal(first.bytesRead, 40);
  assert.equal(first.offset, 0);
  assert.equal(first.size, 100);
  assert.equal(first.eof, false);
  assert.equal(Buffer.from(first.content, 'base64').byteLength, 40);

  const last = await fsReadChunk({ root, relPath: 'blob.bin', offset: 80, length: 40 });
  assert.equal(last.bytesRead, 20);
  assert.equal(last.eof, true);
});

test('fsWriteChunk reports the actual written length and can multi-chunk a file', async (t) => {
  const { fsWriteChunk, fsReadChunk } = await import('./fs.js');
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-wchunk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.alloc(90, 7);
  const first = await fsWriteChunk({
    root,
    relPath: 'out.bin',
    offset: 0,
    content: payload.subarray(0, 50).toString('base64'),
    truncate: true,
  });
  assert.equal(first.bytesWritten, 50);
  const second = await fsWriteChunk({
    root,
    relPath: 'out.bin',
    offset: 50,
    content: payload.subarray(50).toString('base64'),
  });
  assert.equal(second.bytesWritten, 40);
  const read = await fsReadChunk({ root, relPath: 'out.bin', offset: 0, length: 90 });
  assert.equal(read.bytesRead, 90);
  assert.deepEqual(Buffer.from(read.content, 'base64'), payload);
});

test('fsWriteChunk applies explicit mode for private attachment-style files', async (t) => {
  const { fsWriteChunk } = await import('./fs.js');
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-wmode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fsWriteChunk({
    root,
    relPath: 'secret.bin',
    offset: 0,
    content: Buffer.from('private').toString('base64'),
    truncate: true,
    mode: 0o600,
  });
  const mode = (await stat(path.join(root, 'secret.bin'))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('fsReadChunk and fsWriteChunk fail closed above FILE_TRANSFER_CHUNK_MAX_BYTES', async (t) => {
  const { fsReadChunk, fsWriteChunk } = await import('./fs.js');
  const { FILE_TRANSFER_CHUNK_MAX_BYTES } = await import('@farmslot/protocol');
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'big.bin'), Buffer.alloc(FILE_TRANSFER_CHUNK_MAX_BYTES + 10, 1));
  await assert.rejects(
    () =>
      fsReadChunk({
        root,
        relPath: 'big.bin',
        offset: 0,
        length: FILE_TRANSFER_CHUNK_MAX_BYTES + 1,
      }),
    /exceeds FILE_TRANSFER_CHUNK_MAX_BYTES/,
  );
  await assert.rejects(
    () =>
      fsWriteChunk({
        root,
        relPath: 'out.bin',
        offset: 0,
        content: Buffer.alloc(FILE_TRANSFER_CHUNK_MAX_BYTES + 1, 2).toString('base64'),
        truncate: true,
      }),
    /exceeds FILE_TRANSFER_CHUNK_MAX_BYTES/,
  );
});
