import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyDirectoryRecursive } from './copy-tree.js';

test('a copied tree keeps media named for a token but no secret files or folders', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'copy-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  for (const file of [
    'screenshots/evidence-ac3-token-format.png',
    'api-token.txt',
    'token.pem',
    'credentials.json',
    'secrets/shot.png',
    'client-secret.png/id_rsa',
  ]) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), file);
  }
  const destination = path.join(root, 'destination');
  copyDirectoryRecursive(source, destination);
  assert.deepEqual((await readdir(destination, { recursive: true })).sort(), [
    'screenshots',
    path.join('screenshots', 'evidence-ac3-token-format.png'),
  ]);
});
