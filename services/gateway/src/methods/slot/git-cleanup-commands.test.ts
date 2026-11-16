import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLEAR_INDEX_FLAGS_COMMAND,
  CLEAR_INDEX_FLAGS_THEN_REFRESH_COMMAND,
  landDefaultBranchCommand,
  recreateBranchCommand,
  REFRESH_INDEX_AND_UNLOCK_COMMAND,
  REFRESH_REMOTE_REF_LOCKS_COMMAND,
} from './git-cleanup-commands.js';

function runBash(command: string, cwd?: string) {
  return spawnSync('bash', ['-c', 'eval "$CMD"'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CMD: command },
  });
}

function git(cwd: string, ...args: string[]) {
  // Isolate from machine/global core.hooksPath (farmslot pre-commit breaks temp repos).
  const result = spawnSync('git', ['-c', 'core.hooksPath=.git/hooks', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  return result;
}

test('CLEAR_INDEX_FLAGS_COMMAND clears flags for spaces and non-ASCII paths', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'farmslot-git-cleanup-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'core.quotePath', 'true');
    writeFileSync(path.join(repo, 'file with spaces.txt'), 'hello\n');
    writeFileSync(path.join(repo, 'café.txt'), 'bonjour\n');
    git(repo, 'add', 'file with spaces.txt', 'café.txt');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'update-index', '--skip-worktree', '--', 'file with spaces.txt');
    git(repo, 'update-index', '--skip-worktree', '--', 'café.txt');
    git(repo, 'update-index', '--assume-unchanged', '--', 'file with spaces.txt');

    const result = runBash(CLEAR_INDEX_FLAGS_COMMAND, repo);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(git(repo, 'ls-files', '-v').stdout, /^[hsmrckS] /m);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test('CLEAR_INDEX_FLAGS_COMMAND propagates any per-path update-index failure', () => {
  const command = `${CLEAR_INDEX_FLAGS_COMMAND}`;
  const result = spawnSync(
    'bash',
    [
      '-c',
      `git() {
        if [ "$1" = -c ]; then shift 2; fi
        if [ "$1" = ls-files ]; then printf 'S first\\nS second\\n'; return 0; fi
        if [ "$1" = update-index ]; then
          last='';
          for arg in "$@"; do last="$arg"; done;
          [ "$last" = first ] && return 7;
          return 0;
        fi
        command git "$@";
      }
      eval "$CMD"`,
    ],
    { encoding: 'utf8', env: { ...process.env, CMD: command } },
  );

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('CLEAR_INDEX_FLAGS_THEN_REFRESH_COMMAND refreshes after flag failure but returns failure', () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `git() {
        if [ "$1" = -c ]; then shift 2; fi
        if [ "$1" = ls-files ]; then printf 'S first\\nS second\\n'; return 0; fi
        if [ "$1" = update-index ]; then
          if [ "$2" = --refresh ]; then echo REFRESH_RAN; return 0; fi
          last='';
          for arg in "$@"; do last="$arg"; done;
          [ "$last" = first ] && return 7;
          return 0;
        fi
        if [ "$1" = rev-parse ]; then echo /tmp/nonexistent-index.lock; return 0; fi
        command git "$@";
      }
      lsof() { return 1; }
      eval "$CMD"`,
    ],
    { encoding: 'utf8', env: { ...process.env, CMD: CLEAR_INDEX_FLAGS_THEN_REFRESH_COMMAND } },
  );

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /REFRESH_RAN/);
});

test('REFRESH_INDEX_AND_UNLOCK_COMMAND does not remove a lock owned by a process', () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `git() {
        if [ "$1" = rev-parse ]; then echo /tmp/farmslot-owned-index.lock; return 0; fi
        if [ "$1" = update-index ] && [ "$2" = --refresh ]; then echo REFRESH_RAN; return 0; fi
        command git "$@";
      }
      date() { echo 100; }
      stat() { echo 0; }
      lsof() { return 0; }
      rm() { echo RM_CALLED; return 0; }
      touch /tmp/farmslot-owned-index.lock
      trap 'command rm -f /tmp/farmslot-owned-index.lock' EXIT
      eval "$CMD"`,
    ],
    { encoding: 'utf8', env: { ...process.env, CMD: REFRESH_INDEX_AND_UNLOCK_COMMAND } },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /REFRESH_RAN/);
  assert.doesNotMatch(result.stdout, /RM_CALLED/);
});

test('REFRESH_REMOTE_REF_LOCKS_COMMAND removes old unowned remote ref locks', () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `ROOT=$(mktemp -d)
      trap 'command rm -rf "$ROOT"' EXIT
      mkdir -p "$ROOT/origin/feature"
      touch "$ROOT/origin/feature/stale.lock" "$ROOT/packed-refs.lock"
      git() {
        if [ "$1" = rev-parse ] && [ "$2" = --git-path ]; then
          case "$3" in
            refs/remotes/origin) echo "$ROOT/origin"; return 0 ;;
            packed-refs.lock) echo "$ROOT/packed-refs.lock"; return 0 ;;
          esac
        fi
        command git "$@";
      }
      date() { echo 100; }
      stat() { echo 0; }
      lsof() { return 1; }
      eval "$CMD"
      test ! -e "$ROOT/origin/feature/stale.lock"
      test ! -e "$ROOT/packed-refs.lock"`,
    ],
    { encoding: 'utf8', env: { ...process.env, CMD: REFRESH_REMOTE_REF_LOCKS_COMMAND } },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('REFRESH_REMOTE_REF_LOCKS_COMMAND leaves owned remote ref locks in place', () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `ROOT=$(mktemp -d)
      trap 'command rm -rf "$ROOT"' EXIT
      mkdir -p "$ROOT/origin/feature"
      touch "$ROOT/origin/feature/live.lock"
      git() {
        if [ "$1" = rev-parse ] && [ "$2" = --git-path ]; then
          case "$3" in
            refs/remotes/origin) echo "$ROOT/origin"; return 0 ;;
            packed-refs.lock) echo "$ROOT/packed-refs.lock"; return 0 ;;
          esac
        fi
        command git "$@";
      }
      date() { echo 100; }
      stat() { echo 0; }
      lsof() { return 0; }
      rm() { echo RM_CALLED; return 0; }
      eval "$CMD"
      test -e "$ROOT/origin/feature/live.lock"`,
    ],
    { encoding: 'utf8', env: { ...process.env, CMD: REFRESH_REMOTE_REF_LOCKS_COMMAND } },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /RM_CALLED/);
});

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A slot clone on a work branch, its local main one commit behind origin/main. */
function slotBehindOrigin(prefix: string) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const origin = path.join(root, 'origin.git');
  const slot = path.join(root, 'slot');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, slot);
  git(slot, 'config', 'user.email', 't@t');
  git(slot, 'config', 'user.name', 't');
  git(slot, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(slot, 'a.txt'), 'a1\n');
  git(slot, 'add', '.');
  git(slot, 'commit', '-qm', 'c1');
  git(slot, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(slot, 'branch', '-q', '--set-upstream-to=origin/main');
  writeFileSync(path.join(slot, 'b.txt'), 'b1\n');
  git(slot, 'add', '.');
  git(slot, 'commit', '-qm', 'c2');
  git(slot, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(slot, 'reset', '-q', '--hard', 'HEAD~1');
  git(slot, 'checkout', '-q', '-b', 'feat/x');
  return { root, slot };
}

test('landDefaultBranchCommand checks out main at origin/main and keeps its upstream', () => {
  const { root, slot } = slotBehindOrigin('farmslot-land-default-');
  try {
    const upstream = git(slot, 'config', 'branch.main.merge').stdout.trim();
    const result = runBash(landDefaultBranchCommand('main', quote), slot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(slot, 'symbolic-ref', 'HEAD').stdout.trim(), 'refs/heads/main');
    assert.equal(
      git(slot, 'rev-parse', 'HEAD').stdout.trim(),
      git(slot, 'rev-parse', 'origin/main').stdout.trim(),
    );
    assert.equal(git(slot, 'config', 'branch.main.merge').stdout.trim(), upstream);
    assert.equal(git(slot, 'status', '--porcelain').stdout.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('landDefaultBranchCommand is refused when another worktree has main checked out', () => {
  const { root, slot } = slotBehindOrigin('farmslot-land-default-held-');
  try {
    git(slot, 'worktree', 'add', '-q', path.join(root, 'aux'), 'main');
    const before = git(slot, 'rev-parse', 'refs/heads/main').stdout.trim();
    const result = runBash(landDefaultBranchCommand('main', quote), slot);
    assert.notEqual(result.status, 0);
    assert.equal(git(slot, 'rev-parse', 'refs/heads/main').stdout.trim(), before);
    assert.equal(git(slot, 'symbolic-ref', 'HEAD').stdout.trim(), 'refs/heads/feat/x');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recreateBranchCommand recreates the branch at its base with no config from the old one', () => {
  const { root, slot } = slotBehindOrigin('farmslot-recreate-');
  try {
    writeFileSync(path.join(slot, 'w.txt'), 'w\n');
    git(slot, 'add', '.');
    git(slot, 'commit', '-qm', 'work');
    git(slot, 'config', 'branch.feat/x.merge', 'refs/heads/feat/x');
    git(slot, 'checkout', '-q', 'main');
    const base = git(slot, 'rev-parse', 'origin/main').stdout.trim();
    const result = runBash(recreateBranchCommand('feat/x', base, quote), slot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(slot, 'symbolic-ref', 'HEAD').stdout.trim(), 'refs/heads/feat/x');
    assert.equal(git(slot, 'rev-parse', 'HEAD').stdout.trim(), base);
    const config = spawnSync('git', ['config', '--get-regexp', '^branch\\.feat/x\\.'], {
      cwd: slot,
      encoding: 'utf8',
    });
    assert.equal(config.stdout.trim(), '', 'no config left from the old branch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
