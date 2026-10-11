import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultBranchRepoBlocker,
  DETACHED_HEAD_BRANCH,
  isSlotIdleBranch,
  isSlotRefreshStaleBranch,
  readDefaultBranchProbe,
  remoteBranchRefspec,
  resolveSlotTrackingBranch,
} from '../../src/slots/tracking-branch.js';

test('remoteBranchRefspec targets origin by default and a configured remote explicitly', () => {
  assert.equal(
    remoteBranchRefspec('feat/work'),
    '+refs/heads/feat/work:refs/remotes/origin/feat/work',
  );
  assert.equal(
    remoteBranchRefspec('feat/work', 'fork'),
    '+refs/heads/feat/work:refs/remotes/fork/feat/work',
  );
});

test('resolveSlotTrackingBranch uses project template on linked worktrees', () => {
  const branch = resolveSlotTrackingBranch(
    { defaultBranch: 'main', slotTrackingBranch: 'wt/{{session}}' },
    { session: 'ff-2', slotId: 'macwork-ff-2' },
    true,
  );
  assert.equal(branch, 'wt/ff-2');
});

test('resolveSlotTrackingBranch uses default branch on primary clones', () => {
  const branch = resolveSlotTrackingBranch(
    { defaultBranch: 'main', slotTrackingBranch: 'wt/{{session}}' },
    { session: 'fs-main' },
    false,
  );
  assert.equal(branch, 'main');
});

test('isSlotIdleBranch accepts tracking or default branch on linked worktrees', () => {
  assert.equal(isSlotIdleBranch('wt/mm-2', 'wt/mm-2', 'main', true), true);
  assert.equal(isSlotIdleBranch('main', 'wt/ff-2', 'main', true), true);
  assert.equal(isSlotIdleBranch('wt/ff-1', 'wt/ff-2', 'main', true), false);
  assert.equal(isSlotIdleBranch('feat/demo', 'wt/ff-2', 'main', true), false);
});

test('isSlotRefreshStaleBranch uses fleet-probed linkedWorktree signal', () => {
  const project = {
    defaultBranch: 'main',
    slotTrackingBranch: 'wt/{{session}}',
  };
  assert.equal(
    isSlotRefreshStaleBranch('wt/ff-2', project, {
      session: 'ff-2',
      linkedWorktree: true,
    }),
    false,
  );
  assert.equal(
    isSlotRefreshStaleBranch('feat/demo', project, {
      session: 'ff-2',
      linkedWorktree: true,
    }),
    true,
  );
  assert.equal(
    isSlotRefreshStaleBranch('wt/ff-2', project, {
      session: 'ff-2',
      linkedWorktree: false,
    }),
    true,
  );
  assert.equal(
    isSlotRefreshStaleBranch('main', project, { session: 'fs-main', linkedWorktree: false }),
    false,
  );
});

// ─── ADR-054 free-slot: the shared predicate stays conservative ───

test('a detached HEAD is still a stale branch to the shared predicate', () => {
  const project = { defaultBranch: 'main', slotTrackingBranch: 'wt/{{session}}' };
  // This predicate is shared with `slot.release`'s unmerged-work refusal and
  // with fleet health, where a detached HEAD can hold real unpushed commits. It
  // must keep calling those stale; only dispatch scoring may make an exception,
  // and only for a slot a park record proves is preserved.
  assert.equal(isSlotIdleBranch(DETACHED_HEAD_BRANCH, 'wt/ff-2', 'main', true), false);
  assert.equal(isSlotIdleBranch(DETACHED_HEAD_BRANCH, 'main', 'main', false), false);
  assert.equal(
    isSlotRefreshStaleBranch(DETACHED_HEAD_BRANCH, project, {
      session: 'ff-2',
      slotId: 'macwork-ff-2',
      linkedWorktree: true,
    }),
    true,
    'an unexplained detached HEAD must not silence the unmerged-work refusal',
  );
  assert.equal(DETACHED_HEAD_BRANCH, 'HEAD');
});

test('defaultBranchRepoBlocker names a fetch refspec that excludes the default branch', () => {
  const full = ['+refs/heads/*:refs/remotes/origin/*'];
  const local = ['refs/heads/main'];
  assert.equal(defaultBranchRepoBlocker({ fetchRefspecs: full, refs: local }, 'main'), null);
  assert.equal(
    defaultBranchRepoBlocker({ fetchRefspecs: full, refs: ['refs/remotes/origin/main'] }, 'main'),
    null,
  );
  // Explicit, short-source and multi-spec configs that map main to origin/main.
  for (const fetchRefspecs of [
    ['+refs/heads/main:refs/remotes/origin/main'],
    ['main:refs/remotes/origin/main'],
    ['+refs/heads/release/8.14.0:refs/remotes/origin/release/8.14.0', ...full],
  ]) {
    assert.equal(defaultBranchRepoBlocker({ fetchRefspecs, refs: local }, 'main'), null);
  }
  // Fetching main somewhere other than origin/main is not a fetch prepare can use:
  // no `:dst` (FETCH_HEAD only), a mirror into refs/heads, or a glob source with a fixed dst.
  for (const fetchRefspecs of [
    ['+refs/heads/main'],
    ['+refs/*:refs/*'],
    ['+refs/heads/*:refs/remotes/upstream/*'],
    ['+refs/heads/*:refs/remotes/origin/main'],
  ]) {
    assert.match(
      defaultBranchRepoBlocker({ fetchRefspecs, refs: local }, 'main') ?? '',
      /does not fetch default branch 'main' into refs\/remotes\/origin\/main/,
      fetchRefspecs.join(','),
    );
  }
  const single = defaultBranchRepoBlocker(
    {
      fetchRefspecs: ['+refs/heads/release/8.14.0:refs/remotes/origin/release/8.14.0'],
      refs: [],
    },
    'main',
  );
  assert.match(single ?? '', /does not fetch default branch 'main'/);
  assert.match(single ?? '', /release\/8\.14\.0/);
  assert.match(
    defaultBranchRepoBlocker(
      { fetchRefspecs: [...full, '^refs/heads/main'], refs: local },
      'main',
    ) ?? '',
    /does not fetch default branch 'main'/,
  );
  assert.match(
    defaultBranchRepoBlocker({ fetchRefspecs: [], refs: local }, 'main') ?? '',
    /\(none\)/,
  );
  assert.match(
    defaultBranchRepoBlocker({ fetchRefspecs: full, refs: [] }, 'main') ?? '',
    /no default branch 'main'/,
  );
});

test('readDefaultBranchProbe gives no verdict when a git read fails', () => {
  const ok = (stdout: string) =>
    readDefaultBranchProbe({ stdout: `${stdout}probe=done\n`, stderr: '', exitCode: 0 }, 'main');
  assert.deepEqual(
    ok(
      'fetch-exit=0\nfetch=+refs/heads/*:refs/remotes/origin/*\nrefs-exit=0\nref=refs/heads/main\n',
    ),
    { readable: true, blocker: null },
  );
  // No refspec configured (git config exits 1) is a reading, not a failure.
  assert.match(
    (ok('fetch-exit=1\nrefs-exit=0\nref=refs/heads/main\n') as { blocker: string }).blocker,
    /\(none\)/,
  );
  const unreadable = readDefaultBranchProbe(
    {
      stdout:
        'fetch-exit=0\nfetch=+refs/heads/*:refs/remotes/origin/*\nrefs-exit=128\nprobe=done\n',
      stderr: "fatal: could not open '.git/packed-refs' for reading: Permission denied\n",
      exitCode: 0,
    },
    'main',
  );
  assert.deepEqual(unreadable, {
    readable: false,
    error:
      "git for-each-ref exited 128: fatal: could not open '.git/packed-refs' for reading: Permission denied",
  });
  assert.equal(ok('fetch-exit=3\nrefs-exit=0\n').readable, false);
  assert.equal(ok('').readable, false, 'a probe that printed no status has no verdict');
  // Cut short after the ref status (a timeout): no end sentinel, so no verdict, never "missing".
  assert.deepEqual(
    readDefaultBranchProbe(
      {
        stdout: 'fetch-exit=0\nfetch=+refs/heads/*:refs/remotes/origin/*\nrefs-exit=0\n',
        stderr: '',
        exitCode: 0,
      },
      'main',
    ),
    { readable: false, error: 'probe output ended early' },
  );
  assert.equal(
    readDefaultBranchProbe({ stdout: '', stderr: 'ssh: connect refused', exitCode: 255 }, 'main')
      .readable,
    false,
  );
});
