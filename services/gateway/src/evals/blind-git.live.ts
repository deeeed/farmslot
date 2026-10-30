import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { type BlindGitSpec, buildBlindGitCommand } from './blind-git.js';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
function commit(repo: string, text: string): string {
  git(repo, 'add', '.');
  git(
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    text,
  );
  return git(repo, 'rev-parse', 'HEAD');
}
function command(action: 'isolate' | 'verify' | 'restore', spec: BlindGitSpec) {
  return JSON.parse(
    execFileSync('bash', ['-c', buildBlindGitCommand(action, spec)], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    }),
  );
}

for (const linked of [false, true])
  test(`blind Git removes reference objects and restores candidate work, linked=${linked}`, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'blind-git-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    mkdirSync(source);
    git(source, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(source, 'value.txt'), 'base\n');
    writeFileSync(path.join(source, '.gitignore'), 'private-input.txt\n');
    const base = commit(source, 'base');
    writeFileSync(path.join(source, 'value.txt'), 'reference\n');
    writeFileSync(path.join(source, 'answer.txt'), 'later reference-only file\n');
    const reference = commit(source, 'answer');
    git(source, 'remote', 'add', 'origin', path.join(root, 'upstream'));
    git(source, 'update-ref', 'refs/remotes/origin/main', reference);
    const refs = git(source, 'for-each-ref', '--format=%(refname) %(objectname)');
    const repo = linked ? path.join(root, 'linked') : source;
    if (linked) git(source, 'worktree', 'add', '-q', '--detach', repo, 'main');
    writeFileSync(path.join(repo, 'private-input.txt'), 'preserved\n');
    const spec: BlindGitSpec = {
      slotId: 'fixture-slot',
      slotEpoch: 1,
      repo,
      capsule: path.join(root, 'control'),
      runId: 'trial-1',
      branch: 'eval/trial-1',
      baseSha: base,
      referenceCommits: [reference],
    };
    assert.equal(command('isolate', spec).status, 'isolated');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
    assert.equal(readFileSync(path.join(repo, 'value.txt'), 'utf8'), 'base\n');
    assert.equal(existsSync(path.join(repo, 'answer.txt')), false);
    assert.equal(readFileSync(path.join(repo, 'private-input.txt'), 'utf8'), 'preserved\n');
    assert.equal(git(repo, 'remote'), '');
    assert.notEqual(spawnSync('git', ['-C', repo, 'cat-file', '-e', reference], { env }).status, 0);
    assert.notEqual(spawnSync('git', ['-C', repo, 'fetch', 'origin'], { env }).status, 0);
    git(repo, 'fsck', '--full', '--no-reflogs');
    assert.equal(
      command('isolate', spec).status,
      'isolated',
      'prepare replay preserves the isolated store',
    );
    writeFileSync(path.join(repo, 'value.txt'), 'candidate\n');
    const head = commit(repo, 'candidate');
    assert.equal(command('verify', spec).status, 'isolated');
    // Simulate a process exit between retaining isolated metadata and restoring
    // the original entry. The durable restoration journal must recover it.
    const interrupted = spawnSync(
      'python3',
      [
        '-c',
        `
import json, runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name='blind_git_fixture')
rename = Path.rename
def interrupt(source, target):
    if source.name == 'original.entry':
        raise RuntimeError('fixture interrupted restore')
    return rename(source, target)
Path.rename = interrupt
module['restore'](json.loads(sys.argv[2]))
`,
        new URL('./blind-git.py', import.meta.url).pathname,
        JSON.stringify(spec),
      ],
      { env, encoding: 'utf8', timeout: 60_000 },
    );
    assert.notEqual(interrupted.status, 0);
    assert.match(interrupted.stderr, /fixture interrupted restore/);
    assert.equal(existsSync(path.join(repo, '.git')), false);
    assert.equal(command('restore', spec).headSha, head);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(git(repo, 'remote', 'get-url', 'origin'), path.join(root, 'upstream'));
    assert.equal(
      git(source, 'for-each-ref', '--format=%(refname) %(objectname)')
        .split('\n')
        .filter((line) => !line.startsWith('refs/heads/eval/'))
        .join('\n'),
      refs,
    );
    assert.equal(command('restore', spec).status, 'restored');
  });
