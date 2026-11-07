import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ensureNodePtySpawnHelpersExecutable } from './node-pty-helper.js';

test('fresh installation repairs packaged PTY helpers without changing their contents', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-link-pty-helper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'node_modules/node-pty/prebuilds/darwin-arm64');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(root, 'node_modules/node-pty/package.json'), '{"name":"node-pty"}');
  const helper = path.join(directory, 'spawn-helper');
  await writeFile(helper, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  assert.equal((await stat(helper)).mode & 0o111, 0);
  const caller = pathToFileURL(path.join(root, 'entry.mjs')).href;
  ensureNodePtySpawnHelpersExecutable(caller);
  assert.equal((await stat(helper)).mode & 0o111, 0o111);
  const first = await stat(helper);
  ensureNodePtySpawnHelpersExecutable(caller);
  assert.equal((await stat(helper)).mtimeMs, first.mtimeMs);
});
