import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { localWorkspaceVersion } from './workspace-version.js';

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
  const first = await localWorkspaceVersion(vars, 'main');
  assert(first);
  assert.deepEqual(await localWorkspaceVersion(vars, 'main'), first);
  await utimes(index, 1_700_000_001, 1_700_000_001);
  const staged = await localWorkspaceVersion(vars, 'main');
  assert.notDeepEqual(staged, first);
  await writeFile(path.join(repo, '.git/refs/heads/main'), 'b'.repeat(40) + '\n');
  assert.notDeepEqual(await localWorkspaceVersion(vars, 'main'), staged);
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
  const first = await localWorkspaceVersion(vars, 'main');
  assert(first);
  await writeFile(packed, 'b'.repeat(40) + ' refs/heads/main\n');
  await utimes(packed, 1_700_000_001, 1_700_000_001);
  assert.notDeepEqual(await localWorkspaceVersion(vars, 'main'), first);
  const beforeIndex = await localWorkspaceVersion(vars, 'main');
  await writeFile(path.join(gitDir, 'index'), 'worktree index');
  assert.notDeepEqual(await localWorkspaceVersion(vars, 'main'), beforeIndex);
  await writeFile(path.join(gitDir, 'HEAD'), 'c'.repeat(40) + '\n');
  assert.notDeepEqual(await localWorkspaceVersion(vars, 'main'), beforeIndex);
});

test('missing repositories and reftable compatibility HEADs cannot justify reuse', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'workspace-unknown-version-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const vars = { remoteRepo: repo, host: 'localhost', machine: 'local', sshTarget: '' };
  assert.deepEqual(await localWorkspaceVersion(vars, 'main'), undefined);
  await mkdir(path.join(repo, '.git'));
  await writeFile(path.join(repo, '.git/HEAD'), 'ref: refs/heads/.invalid\n');
  assert.deepEqual(await localWorkspaceVersion(vars, 'main'), undefined);
});
