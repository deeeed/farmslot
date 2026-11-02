import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/config.js';
import { farmslotRoot } from '../../projects/repo-root.js';

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

test('resetSlotRepoToIdle refuses to reset the gateway operator root (no destructive git runs)', async () => {
  // A local slot whose repo resolves to farmslotRoot (e.g. a `*-fs-main` slot or
  // `repo: "."`) must be rejected BEFORE any checkout/clean/reset touches the
  // control-plane working tree. We point the slot at the real operator root; the
  // guard throws before running git, so the operator repo is never mutated.
  await assert.rejects(
    resetSlotRepoToIdle(slotVars(farmslotRoot, 'fs-main'), {}, undefined, 'main', {
      linkedWorktree: false,
    }),
    /operator root/,
  );
});

test('resetSlotRepoToIdle refuses a slot pointing at a SUBDIRECTORY of the operator root', async () => {
  // A local slot misconfigured to point inside the operator checkout (e.g.
  // repo: "services/gateway") shares the same git worktree — `git -C <subdir>
  // reset --hard` would still nuke the operator tree. The guard resolves the
  // owning worktree root (git rev-parse --show-toplevel) and rejects it.
  const subdir = path.join(farmslotRoot, 'services');
  await assert.rejects(
    resetSlotRepoToIdle(slotVars(subdir, 'fs-sub'), {}, undefined, 'main', {
      linkedWorktree: false,
    }),
    /operator root/,
  );
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

test('an operator commit made during fetch refuses the idle reset and remains on HEAD', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'idle-reset-fetch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'slot'),
    remote = path.join(root, 'origin.git');
  initPrimaryRepo(repo, remote);
  git(repo, 'config', 'commit.gpgsign', 'false');
  const expected = git(repo, 'rev-parse', 'HEAD');
  const upload = path.join(root, 'upload.sh');
  writeFileSync(
    upload,
    `#!/bin/sh\nset -e\ngit -C '${repo}' -c core.hooksPath=/dev/null commit --allow-empty -qm 'test: operator commit during fetch'\nexec git-upload-pack "$@"\n`,
  );
  git(repo, 'config', 'remote.origin.uploadpack', `sh ${upload}`);
  await assert.rejects(
    resetSlotRepoToIdle(slotVars(repo, 'fetch-race'), {}, undefined, 'main', {
      linkedWorktree: false,
      expect: { headSha: expected, branches: { main: expected } },
    }),
    /changed since inspection/,
  );
  assert.notEqual(git(repo, 'rev-parse', 'HEAD'), expected);
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'test: operator commit during fetch');
});

test('idle reset clears an old unowned index lock without discard confirmation', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'idle-reset-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'slot');
  initPrimaryRepo(repo, path.join(root, 'origin.git'));
  const head = git(repo, 'rev-parse', 'HEAD');
  const lock = path.join(repo, git(repo, 'rev-parse', '--git-path', 'index.lock'));
  writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  await resetSlotRepoToIdle(slotVars(repo, 'stale-lock'), {}, undefined, 'main', {
    expect: { headSha: head, branches: { main: head } },
  });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  git(repo, 'update-index', '--refresh');
});

test('idle reset on its target branch clears an unmerged index', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'idle-reset-conflict-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'slot');
  initPrimaryRepo(repo, path.join(root, 'origin.git'));
  git(repo, 'checkout', '-qb', 'topic');
  writeFileSync(path.join(repo, 'README.md'), 'topic\n');
  git(repo, 'commit', '-qam', 'test: topic');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo, 'README.md'), 'main\n');
  git(repo, 'commit', '-qam', 'test: main');
  assert.equal(spawnSync('git', ['merge', 'topic'], { cwd: repo }).status, 1);
  await resetSlotRepoToIdle(slotVars(repo, 'conflict'), {}, undefined, 'main');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'));
});
