import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLEAR_INDEX_FLAGS_COMMAND,
  CLEAR_INDEX_FLAGS_THEN_REFRESH_COMMAND,
  DISABLE_AUTO_MAINTENANCE_COMMAND,
  FETCH_MAINTENANCE_COMMAND,
  gitMaintenanceNotes,
  PRE_FETCH_CLEANUP_COMMAND,
  recreateBranchCommand,
  REFRESH_INDEX_AND_UNLOCK_COMMAND,
  REFRESH_REMOTE_REF_LOCKS_COMMAND,
  REMOVE_STALE_TMP_PACKS_COMMAND,
  remotePruneCommand,
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

test('recreateBranchCommand is refused, config kept, when another worktree holds the branch', () => {
  const { root, slot } = slotBehindOrigin('farmslot-recreate-held-');
  try {
    git(slot, 'config', 'branch.feat/x.merge', 'refs/heads/feat/x');
    git(slot, 'checkout', '-q', 'main');
    git(slot, 'worktree', 'add', '-q', path.join(root, 'aux'), 'feat/x');
    const before = git(slot, 'rev-parse', 'refs/heads/feat/x').stdout.trim();
    const base = git(slot, 'rev-parse', 'origin/main').stdout.trim();
    const result = runBash(recreateBranchCommand('feat/x', base, quote), slot);
    assert.notEqual(result.status, 0);
    assert.equal(git(slot, 'rev-parse', 'refs/heads/feat/x').stdout.trim(), before);
    assert.equal(git(slot, 'config', 'branch.feat/x.merge').stdout.trim(), 'refs/heads/feat/x');
    assert.equal(git(slot, 'symbolic-ref', 'HEAD').stdout.trim(), 'refs/heads/main');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Runs `script` in bash inside a fresh repo at $ROOT/repo with $PACK set to its pack directory.
 * `fakeLsof`, when set, is the body of an `lsof` placed first on PATH.
 */
function inRepo(
  script: string,
  options: { command?: string; fakeLsof?: string; shell?: string } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'git-cleanup-'));
  try {
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    if (options.fakeLsof !== undefined) {
      writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh\n${options.fakeLsof}\n`, { mode: 0o755 });
    }
    return spawnSync(
      options.shell ?? 'bash',
      [
        '-c',
        `export ROOT="$1"; git init -q "$ROOT/repo" && cd "$ROOT/repo" || exit 1
        PACK=$(cd .git/objects/pack && pwd -P)
        old() { touch -t 202601010000 "$@"; }
        ${script}`,
        '_',
        root,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CMD: options.command ?? REMOVE_STALE_TMP_PACKS_COMMAND,
          PATH: `${bin}:${process.env.PATH}`,
          GIT_CONFIG_GLOBAL: path.join(root, 'global'),
        },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('REMOVE_STALE_TMP_PACKS_COMMAND removes temporary packs a killed fetch left, and keeps live ones', () => {
  const result =
    inRepo(`old "$PACK/tmp_pack_stale" "$PACK/tmp_idx_stale" "$PACK/tmp_rev_stale" "$PACK/tmp_pack_held" "$PACK/pack-kept.pack"
    touch "$PACK/tmp_pack_fresh"
    # A process still writing an old-looking temporary pack keeps it. exec: no forked child to leak.
    bash -c 'exec 3<"$1"; exec sleep 30' _ "$PACK/tmp_pack_held" </dev/null >/dev/null 2>&1 &
    holder=$!
    trap 'kill "$holder" 2>/dev/null' EXIT
    for _ in $(seq 100); do lsof -p "$holder" 2>/dev/null | grep -q tmp_pack_held && break; sleep 0.05; done
    eval "$CMD"
    echo "left: $(ls "$PACK" | sort | tr '\\n' ' ')"`);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /left: pack-kept\.pack tmp_pack_fresh tmp_pack_held $/m);
  assert.deepEqual(gitMaintenanceNotes(result.stdout), ['removed 3 stale tmp packs']);
});

test('REMOVE_STALE_TMP_PACKS_COMMAND deletes nothing when lsof fails or is killed', () => {
  // Silent failures, and one that lists the pack directory and then dies mid-listing.
  for (const fakeLsof of ['exit 1', 'kill -9 $$', 'printf "n%s\\n" "$3"; kill -9 $$']) {
    const result = inRepo(
      `old "$PACK/tmp_pack_stale"
      eval "$CMD"
      echo "left: $(ls "$PACK")"`,
      { fakeLsof },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /left: tmp_pack_stale/, `lsof: ${fakeLsof}`);
    assert.deepEqual(gitMaintenanceNotes(result.stdout), [
      'kept stale tmp packs: the open-file check did not complete',
    ]);
  }
});

test('REMOVE_STALE_TMP_PACKS_COMMAND deletes nothing without lsof', () => {
  // Every tool the command runs stays on PATH; only lsof is missing.
  const result = inRepo(`old "$PACK/tmp_pack_stale"
    tools="$ROOT/tools"; mkdir "$tools"
    for name in git find sed grep awk rm wc tr; do ln -s "$(command -v "$name")" "$tools/$name"; done
    PATH="$tools" eval "$CMD"
    echo "left: $(ls "$PACK")"`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /left: tmp_pack_stale/);
  assert.deepEqual(gitMaintenanceNotes(result.stdout), [
    'kept stale tmp packs: lsof is not available',
  ]);
});

test('REMOVE_STALE_TMP_PACKS_COMMAND runs no lsof when there is nothing stale', () => {
  const result = inRepo(
    `touch "$PACK/tmp_pack_fresh"; old "$PACK/pack-kept.pack"
    eval "$CMD"
    [ -e "$ROOT/lsof-ran" ] && echo "lsof ran" || echo "lsof skipped"`,
    {
      fakeLsof: 'touch "$ROOT/lsof-ran"; exit 1',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lsof skipped/);
});

test('DISABLE_AUTO_MAINTENANCE_COMMAND turns off auto-maintenance once and unregisters only this repo', () => {
  const result = inRepo(
    `git config --global --add maintenance.repo "$(git rev-parse --show-toplevel)"
    git config --global --add maintenance.repo /some/other/repo
    eval "$CMD"
    echo "auto=$(git config --local --get maintenance.auto) gc=$(git config --local --get gc.auto) repos=$(git config --global --get-all maintenance.repo | tr '\\n' ' ')"
    # Already set: a second run only reads. With .git unwritable, any write would fail and print a note.
    chmod a-w .git
    second=$(eval "$CMD" 2>&1)
    chmod u+w .git
    echo "second=[$second]"`,
    { command: DISABLE_AUTO_MAINTENANCE_COMMAND },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^auto=false gc=0 repos=\/some\/other\/repo $/m);
  assert.match(result.stdout, /^second=\[\]$/m);
});

test('DISABLE_AUTO_MAINTENANCE_COMMAND leaves the config of a linked worktree, which shares it, alone', () => {
  const result = inRepo(
    `git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m base
    git worktree add -q "$ROOT/linked" -b linked
    cd "$ROOT/linked" && eval "$CMD"
    cd "$ROOT/repo" && echo "auto=[$(git config --local --get maintenance.auto)] gc=[$(git config --local --get gc.auto)]"`,
    { command: DISABLE_AUTO_MAINTENANCE_COMMAND },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^auto=\[\] gc=\[\]$/m);
  // An expected state, so no note a caller would surface: only a debug line.
  assert.deepEqual(gitMaintenanceNotes(result.stdout), []);
  assert.match(
    result.stdout,
    /^farmslot-git-maintenance-debug: config left unchanged: this linked worktree shares it with \/.+\/repo\/\.git$/m,
  );
});

test(
  'PRE_FETCH_CLEANUP_COMMAND works under the node-link shell (zsh -f)',
  { skip: !existsSync('/bin/zsh') },
  () => {
    const result = inRepo(
      `old "$PACK/tmp_pack_stale"
    /bin/zsh -f -c 'eval "$CMD"'
    echo "left=[$(ls "$PACK")] auto=$(git config --local --get maintenance.auto) gc=$(git config --local --get gc.auto)"`,
      { command: PRE_FETCH_CLEANUP_COMMAND },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /left=\[\] auto=false gc=0/);
  },
);

test('the pre-fetch cleanups clear ref locks, auto-maintenance and stale temporary packs', () => {
  assert.ok(FETCH_MAINTENANCE_COMMAND.includes(DISABLE_AUTO_MAINTENANCE_COMMAND));
  assert.ok(FETCH_MAINTENANCE_COMMAND.includes(REMOVE_STALE_TMP_PACKS_COMMAND));
  assert.ok(PRE_FETCH_CLEANUP_COMMAND.includes(FETCH_MAINTENANCE_COMMAND));
  assert.ok(PRE_FETCH_CLEANUP_COMMAND.includes(REFRESH_REMOTE_REF_LOCKS_COMMAND));
});

test('gitMaintenanceNotes keeps only the maintenance notes', () => {
  assert.deepEqual(
    gitMaintenanceNotes(
      'From origin\nfarmslot-git-maintenance: removed 2 stale tmp packs\n * branch main\n',
    ),
    ['removed 2 stale tmp packs'],
  );
});

/** An origin with main and two branches, and a slot clone of it that has fetched them all. */
const PRUNE_FIXTURE = `ROOT=$(mktemp -d)
  trap 'command rm -rf "$ROOT"' EXIT
  g() { git -c user.name=T -c user.email=t@localhost -c commit.gpgsign=false "$@"; }
  git init -q --bare -b main "$ROOT/origin.git"
  g clone -q "$ROOT/origin.git" "$ROOT/seed" 2>/dev/null
  (cd "$ROOT/seed" && g commit -q --allow-empty -m base && g push -q origin main main:refs/heads/feat/gone main:refs/heads/feat/later)
  g clone -q "$ROOT/origin.git" "$ROOT/slot"
  cd "$ROOT/slot"
  remote_refs() { git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin | tr '\\n' ' '; }`;

test('remotePruneCommand drops refs whose branch origin deleted, at most once per window', () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `${PRUNE_FIXTURE}
      git -C "$ROOT/origin.git" update-ref -d refs/heads/feat/gone
      eval "$CMD"
      echo "first=$(remote_refs)"
      # Within the window a second refresh does not prune again.
      git -C "$ROOT/origin.git" update-ref -d refs/heads/feat/later
      eval "$CMD"
      echo "second=$(remote_refs)"
      # Once the stamp is older than the window, it prunes.
      touch -t 202601010000 "$(git rev-parse --absolute-git-dir)/farmslot-remote-prune.stamp"
      eval "$CMD"
      echo "third=$(remote_refs)"`,
    ],
    { encoding: 'utf8', env: { ...process.env, CMD: remotePruneCommand(24) } },
  );

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.deepEqual(gitMaintenanceNotes(result.stdout), [
    'pruned 1 remote refs whose branch is gone',
    'pruned 1 remote refs whose branch is gone',
  ]);
  assert.deepEqual(
    lines.filter((line) => !line.startsWith('farmslot-git-maintenance:')),
    ['first=HEAD feat/later main ', 'second=HEAD feat/later main ', 'third=HEAD main '],
  );
});

test('remotePruneCommand leaves a git dir other worktrees share alone', () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `${PRUNE_FIXTURE}
      git worktree add -q "$ROOT/linked" -b linked-work origin/main
      git -C "$ROOT/origin.git" update-ref -d refs/heads/feat/gone
      (cd "$ROOT/linked" && eval "$CMD")
      eval "$CMD"
      echo "refs=$(remote_refs)"`,
    ],
    { encoding: 'utf8', env: { ...process.env, CMD: remotePruneCommand(24) } },
  );

  assert.equal(result.status, 0, result.stderr);
  const notes = gitMaintenanceNotes(result.stdout);
  assert.equal(notes.length, 2);
  for (const note of notes) assert.match(note, /remote prune skipped: the git dir .* is shared by 2 worktrees/);
  assert.match(result.stdout, /refs=HEAD feat\/gone feat\/later main/);
});

test('remotePruneCommand prunes nothing while two remote refs differ only in case', () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `${PRUNE_FIXTURE}
      # GitHub allows both names; on APFS deleting one loose ref also deletes the other.
      git update-ref refs/remotes/origin/feat/CASE origin/main
      git pack-refs --all
      git update-ref refs/remotes/origin/feat/case origin/main
      git -C "$ROOT/origin.git" update-ref -d refs/heads/feat/gone
      eval "$CMD"
      echo "refs=$(remote_refs)"`,
    ],
    { encoding: 'utf8', env: { ...process.env, CMD: remotePruneCommand(24) } },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(gitMaintenanceNotes(result.stdout), [
    'remote prune skipped: refs differ only in case (refs/remotes/origin/feat/case)',
  ]);
  assert.match(result.stdout, /feat\/gone/);
});
