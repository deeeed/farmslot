import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fsHash, fsList, fsWriteFiles } from './fs.js';

test('fsList filters symlinks out of remote file listings', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-'));
  const linkedDir = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-link-'));
  await mkdir(path.join(root, 'dir'));
  await writeFile(path.join(root, 'file.txt'), 'ok', 'utf-8');
  await symlink(linkedDir, path.join(root, 'linked-dir'));

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(linkedDir, { recursive: true, force: true });
  });

  const result = await fsList({ path: root });
  assert.deepEqual(result.entries, [
    { name: 'dir', type: 'directory' },
    { name: 'file.txt', type: 'file', size: 2 },
  ]);
});

test('fsHash streams a sha256 digest for remote artifact scans', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-hash-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const content = 'same-size artifact content\n';
  const filePath = path.join(root, 'artifact.txt');
  await writeFile(filePath, content, 'utf-8');

  const result = await fsHash({ path: filePath });
  assert.deepEqual(result, {
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
  });
});

test('fsWriteFiles materializes a nested bundle with parent dirs and modes', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'farmslot-node-fs-bundle-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const result = await fsWriteFiles({
    baseDir: base,
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
      baseDir: base,
      files: [{ path: '../escape.sh', content: Buffer.from('x').toString('base64') }],
    }),
    /escaping baseDir/,
  );
});
