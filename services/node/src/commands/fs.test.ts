import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fsHash, fsList } from './fs.js';

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
