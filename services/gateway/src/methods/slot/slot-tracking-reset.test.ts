import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/config.js';

import { resetSlotRepoToIdle } from './slot-tracking.js';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=.git/hooks', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  return result.stdout.trim();
}

function slotVars(remoteRepo: string, session: string): SlotVars {
  return {
    machine: 'macwork',
    platform: 'macos',
    host: 'localhost',
    sshUser: 'deeeed',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: remoteRepo,
    remoteRepo,
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    projectName: 'farmslot-farm',
    slotId: `macwork-${session}`,
    session,
    resourceVars: {},
  };
}

function initPrimaryRepo(primary: string, bareRemote: string) {
  mkdirSync(primary, { recursive: true });
  mkdirSync(bareRemote, { recursive: true });
  git(primary, 'init', '-q');
  git(primary, 'config', 'user.email', 'test@example.com');
  git(primary, 'config', 'user.name', 'Test');
  writeFileSync(path.join(primary, 'README.md'), 'base\n');
  git(primary, 'add', 'README.md');
  git(primary, 'commit', '-qm', 'init');
  git(primary, 'branch', '-M', 'main');
  git(bareRemote, 'init', '--bare', '-q');
  git(primary, 'remote', 'add', 'origin', bareRemote);
  git(primary, 'push', '-u', 'origin', 'main');
}

test('resetSlotRepoToIdle returns linked worktree to tracking branch @ origin/main', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-slot-tracking-'));
  const primary = path.join(root, 'primary');
  const bareRemote = path.join(root, 'origin.git');
  const worktree = path.join(root, 'wt');
  try {
    initPrimaryRepo(primary, bareRemote);
    git(primary, 'worktree', 'add', '-b', 'wt/ff-2', worktree, 'main');
    git(worktree, 'checkout', '-b', 'feat/demo');
    writeFileSync(path.join(worktree, 'README.md'), 'feature\n');
    git(worktree, 'add', 'README.md');
    git(worktree, 'commit', '-qm', 'feature');

    const result = await resetSlotRepoToIdle(
      slotVars(worktree, 'ff-2'),
      { slot_tracking_branch: 'wt/{{session}}' },
      undefined,
      'main',
      { linkedWorktree: true },
    );

    assert.equal(result.trackingBranch, 'wt/ff-2');
    assert.equal(result.previousBranch, 'feat/demo');
    assert.equal(result.linkedWorktree, true);
    assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wt/ff-2');
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), git(worktree, 'rev-parse', 'origin/main'));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('resetSlotRepoToIdle returns primary clone to default branch @ origin/main', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-slot-tracking-'));
  const primary = path.join(root, 'primary');
  const bareRemote = path.join(root, 'origin.git');
  try {
    initPrimaryRepo(primary, bareRemote);
    git(primary, 'checkout', '-b', 'feat/demo');
    writeFileSync(path.join(primary, 'README.md'), 'feature\n');
    git(primary, 'add', 'README.md');
    git(primary, 'commit', '-qm', 'feature');

    const result = await resetSlotRepoToIdle(slotVars(primary, 'fs-main'), {}, undefined, 'main', {
      linkedWorktree: false,
    });

    assert.equal(result.trackingBranch, 'main');
    assert.equal(result.previousBranch, 'feat/demo');
    assert.equal(result.linkedWorktree, false);
    assert.equal(git(primary, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(primary, 'rev-parse', 'HEAD'), git(primary, 'rev-parse', 'origin/main'));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
