import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256File } from './file-hash.js';

test('shared gateway hash reads current bytes, follows existing symlinks and returns bare SHA256', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-file-hash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'evidence.json');
  const link = path.join(root, 'link.json');
  await writeFile(target, 'evidence');
  await symlink(target, link);
  assert.equal(await sha256File(link), createHash('sha256').update('evidence').digest('hex'));
  await writeFile(target, 'changed');
  assert.equal(await sha256File(target), createHash('sha256').update('changed').digest('hex'));
  await assert.rejects(sha256File(path.join(root, 'missing')), /ENOENT/);
});

test(
  'gateway hashes return descriptors after concurrent reads',
  { skip: !['darwin', 'linux'].includes(process.platform) },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-hash-fds-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = path.join(root, 'evidence.json');
    await writeFile(target, 'evidence'.repeat(4096));
    const count = () =>
      readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length;
    const before = count();
    await Promise.all(Array.from({ length: 64 }, () => sha256File(target)));
    assert.ok(count() <= before + 2);
  },
);
