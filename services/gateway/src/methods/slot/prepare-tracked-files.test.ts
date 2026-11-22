import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildChangedPathsCommand,
  buildDirtyPathsCommand,
  buildTrackedFilesSnapshotCommand,
  changedSubmodules,
  changedTrackedFiles,
  parseNulPaths,
  parseTrackedFilesSnapshot,
  snapshotsEqual,
  trackedFilesChangedMessage,
  type TrackedFilesSnapshot,
} from './prepare-tracked-files.js';

const sh = (command: string) => execFileSync('bash', ['-c', command], { encoding: 'utf8' });

function fixture(t: { after: (fn: () => void) => void }) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'prepare-tracked-unit-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=F',
        '-c',
        'user.email=f@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  writeFileSync(path.join(repo, 'line\nbreak.txt'), 'n\n');
  writeFileSync(path.join(repo, 'target-1'), '1\n');
  writeFileSync(path.join(repo, 'target-2'), '2\n');
  symlinkSync('target-1', path.join(repo, 'link'));
  git('add', '.');
  git('commit', '-qm', 'seed');
  const snap = (): TrackedFilesSnapshot => {
    const snapshot = parseTrackedFilesSnapshot(sh(buildTrackedFilesSnapshotCommand(repo)));
    assert.ok(snapshot, 'expected a merged index');
    return snapshot;
  };
  // Mirrors prepare's checkTrackedFiles.
  const files = (before: TrackedFilesSnapshot, after: TrackedFilesSnapshot) =>
    [
      ...new Set([
        ...changedTrackedFiles(
          parseNulPaths(sh(buildChangedPathsCommand(repo, before, after))),
          parseNulPaths(sh(buildDirtyPathsCommand(repo, after))),
        ),
        ...changedSubmodules(before, after),
      ]),
    ].sort();
  return { repo, git, snap, files };
}

test('a clean checkout snapshots as HEAD and compares equal to itself', (t) => {
  const { git, snap } = fixture(t);
  const s = snap();
  assert.equal(s.worktreeTree, git('rev-parse', 'HEAD^{tree}'));
  assert.equal(s.indexTree, s.worktreeTree);
  assert.equal(s.branch, 'refs/heads/main');
  assert.ok(snapshotsEqual(s, snap()));
});

test('the snapshot leaves the checkout, index and stash list untouched', (t) => {
  const { repo, git, snap } = fixture(t);
  writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
  git('add', 'a.txt');
  writeFileSync(path.join(repo, 'a.txt'), 'dirtier\n');
  const status = git('status', '--porcelain=v1');
  snap();
  assert.equal(git('status', '--porcelain=v1'), status);
  assert.equal(git('stash', 'list'), '');
});

test('symlink retarget, broken symlink and a newline in a filename are reported exactly', (t) => {
  const { repo, snap, files } = fixture(t);
  const before = snap();
  unlinkSync(path.join(repo, 'link'));
  symlinkSync('target-2', path.join(repo, 'link'));
  writeFileSync(path.join(repo, 'line\nbreak.txt'), 'changed\n');
  assert.deepEqual(files(before, snap()), ['line\nbreak.txt', 'link']);

  const retargeted = snap();
  unlinkSync(path.join(repo, 'link'));
  symlinkSync('missing-target', path.join(repo, 'link'));
  assert.deepEqual(files(retargeted, snap()), ['link']);
});

test('staging an already-dirty file is a change', (t) => {
  const { repo, git, snap, files } = fixture(t);
  writeFileSync(path.join(repo, 'a.txt'), 'worker edit\n');
  const before = snap();
  git('add', 'a.txt');
  const after = snap();
  assert.equal(before.worktreeTree, after.worktreeTree);
  assert.deepEqual(files(before, after), ['a.txt']);
});

test('switching branch at the same commit is reported', (t) => {
  const { git, snap } = fixture(t);
  const before = snap();
  git('checkout', '-q', '-b', 'other');
  const after = snap();
  assert.match(
    trackedFilesChangedMessage('deps', 'cmd', 'slot-1', before, after, []) ?? '',
    /^prepare deps switched branch on slot-1 \(refs\/heads\/main -> refs\/heads\/other\)/,
  );
});

test('restoring a replay-dirty file to HEAD is allowed; changing it further is not', (t) => {
  const { repo, git, snap, files } = fixture(t);
  writeFileSync(path.join(repo, 'a.txt'), 'replay residue\n');
  const before = snap();
  git('checkout', 'HEAD', '--', 'a.txt');
  const restored = snap();
  assert.equal(snapshotsEqual(before, restored), false);
  assert.deepEqual(files(before, restored), []);

  writeFileSync(path.join(repo, 'a.txt'), 'replay residue\n');
  const dirtyAgain = snap();
  writeFileSync(path.join(repo, 'a.txt'), 'rewritten\n');
  assert.deepEqual(files(dirtyAgain, snap()), ['a.txt']);
});

test('a file rewritten with identical bytes is not a change', (t) => {
  const { repo, snap, files } = fixture(t);
  const before = snap();
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  const after = snap();
  assert.ok(snapshotsEqual(before, after));
  assert.deepEqual(files(before, after), []);
});

test('a conflicted index yields no snapshot instead of failing', (t) => {
  const { repo, git } = fixture(t);
  git('checkout', '-q', '-b', 'theirs');
  writeFileSync(path.join(repo, 'a.txt'), 'theirs\n');
  git('commit', '-qam', 'theirs');
  git('checkout', '-q', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'ours\n');
  git('commit', '-qam', 'ours');
  assert.throws(() => git('merge', '-q', 'theirs'));
  assert.equal(parseTrackedFilesSnapshot(sh(buildTrackedFilesSnapshotCommand(repo))), null);
});

test('a moved submodule is reported even with submodule ignore=all', (t) => {
  const { repo, git, snap, files } = fixture(t);
  const sub = mkdtempSync(path.join(os.tmpdir(), 'prepare-tracked-sub-'));
  t.after(() => rmSync(sub, { recursive: true, force: true }));
  const subGit = (dir: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'user.name=F',
        '-c',
        'user.email=f@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  subGit(sub, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(sub, 's.txt'), '1\n');
  subGit(sub, 'add', '.');
  subGit(sub, 'commit', '-qm', 'one');
  writeFileSync(path.join(sub, 's.txt'), '2\n');
  subGit(sub, 'commit', '-qam', 'two');
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
  git('config', '-f', '.gitmodules', 'submodule.vendor/sub.ignore', 'all');
  git('add', '.gitmodules');
  git('commit', '-qm', 'add submodule');
  const before = snap();
  subGit(path.join(repo, 'vendor/sub'), 'checkout', '-q', 'HEAD~1');
  const moved = snap();
  assert.equal(snapshotsEqual(before, moved), false);
  assert.deepEqual(files(before, moved), ['vendor/sub']);
  subGit(path.join(repo, 'vendor/sub'), 'checkout', '-q', 'main');
  assert.deepEqual(files(moved, snap()), [], 'moving back to the gitlink is a restore');
});
