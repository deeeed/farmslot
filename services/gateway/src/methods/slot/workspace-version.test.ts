import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { workspaceVersion } from './workspace-version.js';

test('unchanged Git metadata reuses a version; index writes and same-branch commits change it', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'workspace-version-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await mkdir(path.join(repo, '.git/refs/heads'), { recursive: true });
  await writeFile(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(repo, '.git/refs/heads/main'), 'a'.repeat(40) + '\n');
  const index = path.join(repo, '.git/index');
  await writeFile(index, 'index');
  await utimes(index, 1_700_000_000, 1_700_000_000);
  const vars = { remoteRepo: repo, host: 'localhost', machine: 'local', sshTarget: '' };
  const first = await workspaceVersion(vars, 'main');
  assert(first);
  assert.equal(await workspaceVersion(vars, 'main'), first);
  await utimes(index, 1_700_000_001, 1_700_000_001);
  const staged = await workspaceVersion(vars, 'main');
  assert.notEqual(staged, first);
  await writeFile(path.join(repo, '.git/refs/heads/main'), 'b'.repeat(40) + '\n');
  assert.notEqual(await workspaceVersion(vars, 'main'), staged);
});

test('linked worktrees observe their own index and the common packed refs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-linked-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'checkout');
  const gitDir = path.join(root, 'shared/worktrees/checkout');
  await mkdir(repo);
  await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(repo, '.git'), 'gitdir: ../shared/worktrees/checkout\n');
  await writeFile(path.join(gitDir, 'commondir'), '../..\n');
  await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  const packed = path.join(root, 'shared/packed-refs');
  await writeFile(packed, 'a'.repeat(40) + ' refs/heads/main\n');
  await utimes(packed, 1_700_000_000, 1_700_000_000);
  const vars = { remoteRepo: repo, host: 'localhost', machine: 'local', sshTarget: '' };
  const first = await workspaceVersion(vars, 'main');
  assert(first);
  await writeFile(packed, 'b'.repeat(40) + ' refs/heads/main\n');
  await utimes(packed, 1_700_000_001, 1_700_000_001);
  assert.notEqual(await workspaceVersion(vars, 'main'), first);
  const beforeIndex = await workspaceVersion(vars, 'main');
  await writeFile(path.join(gitDir, 'index'), 'worktree index');
  assert.notEqual(await workspaceVersion(vars, 'main'), beforeIndex);
  await writeFile(path.join(gitDir, 'HEAD'), 'c'.repeat(40) + '\n');
  assert.notEqual(await workspaceVersion(vars, 'main'), beforeIndex);
});

test('missing repositories and reftable compatibility HEADs cannot justify reuse', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'workspace-unknown-version-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const vars = { remoteRepo: repo, host: 'localhost', machine: 'local', sshTarget: '' };
  assert.equal(await workspaceVersion(vars, 'main'), undefined);
  await mkdir(path.join(repo, '.git'));
  await writeFile(path.join(repo, '.git/HEAD'), 'ref: refs/heads/.invalid\n');
  assert.equal(await workspaceVersion(vars, 'main'), undefined);
});

test('remote metadata uses one connection-bound budget instead of the default RPC deadline', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const requests: Array<{ timeout?: number; requireSameConnection?: boolean }> = [];
  const vars: Parameters<typeof workspaceVersion>[0] = {
    remoteRepo: '/fixture',
    host: 'remote.invalid',
    machine: 'remote-fixture',
    sshTarget: '',
    nodeRequest: async (method, _params, options) => {
      requests.push({ ...options });
      now += 600;
      return method === 'fs.exists'
        ? { exists: true }
        : { isDirectory: true, isFile: false, size: 1, mtimeMs: 1 };
    },
  };
  await assert.rejects(workspaceVersion(vars, 'main'), /timeout after 1000ms/);
  assert.deepEqual(requests, [
    { timeout: 1000, requireSameConnection: true },
    { timeout: 400, requireSameConnection: true },
  ]);
});
