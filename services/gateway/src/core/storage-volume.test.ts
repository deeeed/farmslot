import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertStorageVolumePresent, storageVolumeError } from './storage-volume.js';

test('missing and recreated mount points remain unavailable, including dangling store links', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'storage-volume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const volumes = path.join(root, 'Volumes');
  await mkdir(volumes);
  const mount = path.join(volumes, 'proof');
  const link = path.join(root, 'archive');
  await symlink(path.join(mount, 'archives'), link);
  for (const target of [path.join(mount, 'slot'), link, path.join(link, 'run-1')]) {
    const error = storageVolumeError(target, volumes);
    assert(error);
    assert.match(error, /Storage unavailable.*proof.*reconnect/i);
    assert.throws(() => assertStorageVolumePresent(target, volumes), /Storage unavailable/);
  }
  await mkdir(mount);
  const error = storageVolumeError(path.join(mount, 'slot'), volumes);
  assert(error);
  assert.match(error, /not mounted/);
  assert.equal(storageVolumeError(path.join(root, 'new-store'), volumes), undefined);
});
