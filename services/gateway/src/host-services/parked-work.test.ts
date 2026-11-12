import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { execOnSlot } from '../core/exec.js';
import { makeVars } from '../runners/test-fixtures.js';

import {
  executeParkedGitMutation,
  parkGitWork,
  pruneParkedGitWork,
  readParkedGitWork,
  restoreParkedGitWork,
} from './parked-work.js';

const execute = promisify(execFile);
const localExec: typeof execOnSlot = async (_vars, command) => {
  try {
    const result = await execute('bash', ['-c', command]);
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (!(error instanceof Error) || !('stdout' in error) || !('stderr' in error)) throw error;
    return { stdout: String(error.stdout), stderr: String(error.stderr), exitCode: 1 };
  }
};
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'park-work-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repo = path.join(root, 'repo');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.name', 'Proof');
  git('config', 'user.email', 'proof@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.excludesFile', '/dev/null');
  await writeFile(path.join(repo, 'tracked'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'ticket');
  git('commit', '-qm', 'local', '--allow-empty');
  const vars = makeVars({ slotId: 'proof', remoteRepo: repo, repo });
  const options = {
    slotId: 'proof',
    operationKey: 'run-proof',
    defaultBranch: 'main',
    purpose: 'prior-work' as const,
    at: '2026-11-13T00:00:00Z',
  };
  const mutate = async (capture: Awaited<ReturnType<typeof parkGitWork>>) => {
    const result = await executeParkedGitMutation(
      vars,
      { slotId: 'proof' },
      capture,
      `git reset --hard '${base}' && git clean -fd`,
      localExec,
    );
    assert.equal(result.exitCode, 0, result.stderr);
  };
  return { root, repo, vars, git, options, base, mutate };
}

test('dirty capture survives reset and GC, then restores index, working files, symlinks and modes', async (t) => {
  const { vars, repo, git, options, mutate } = await fixture(t);
  await writeFile(path.join(repo, 'tracked'), 'staged\n');
  git('add', 'tracked');
  await writeFile(path.join(repo, 'tracked'), 'working\n');
  await writeFile(path.join(repo, 'untracked'), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(repo, 'executable'), '#!/bin/sh\n');
  await chmod(path.join(repo, 'executable'), 0o755);
  await symlink('tracked', path.join(repo, 'link'));
  const before = git('status', '--porcelain=v1', '-z');
  const index = git('show', ':tracked');
  const capture = await parkGitWork(vars, options, localExec);
  const receipt = capture.receipts[0];
  assert.equal(receipt.kind, 'worktree');
  assert.equal(git('status', '--porcelain=v1', '-z'), before);
  assert.equal(git('show', ':tracked'), index);
  await mutate(capture);
  git('reflog', 'expire', '--expire=now', '--all');
  git('gc', '--prune=now');
  const clean = await parkGitWork(
    vars,
    { ...options, operationKey: 'restore', onlyThreatened: true },
    localExec,
  );
  assert.equal(clean.receipts.length, 0);
  const restored = await restoreParkedGitWork(vars, { slotId: 'proof' }, clean, receipt, localExec);
  assert.match(restored.branch, /^restored\/parked-/);
  assert.equal(git('show', ':tracked'), 'staged');
  assert.equal(await readFile(path.join(repo, 'tracked'), 'utf8'), 'working\n');
  assert.deepEqual(await readFile(path.join(repo, 'untracked')), Buffer.from([0, 1, 2, 255]));
  assert.equal(await readlink(path.join(repo, 'link')), 'tracked');
  assert.equal((await lstat(path.join(repo, 'executable'))).mode & 0o111, 0o111);
  assert.equal(git('status', '--porcelain=v1', '-z'), before);
});

test('exact retries reuse refs while a new index snapshot at unchanged HEAD has a distinct key', async (t) => {
  const { vars, repo, git, options } = await fixture(t);
  await writeFile(path.join(repo, 'tracked'), 'one');
  git('add', 'tracked');
  await writeFile(path.join(repo, 'tracked'), 'working');
  const first = await parkGitWork(vars, options, localExec);
  const repeated = await parkGitWork(vars, { ...options, at: '2026-11-14T00:00:00Z' }, localExec);
  assert.deepEqual(repeated.receipts, first.receipts);
  await writeFile(path.join(repo, 'tracked'), 'two');
  git('add', 'tracked');
  await writeFile(path.join(repo, 'tracked'), 'working');
  const second = await parkGitWork(vars, options, localExec);
  assert.notEqual(first.receipts[0].ref, second.receipts[0].ref);
  assert.equal((await readParkedGitWork(vars, 'proof', localExec)).receipts.length, 2);
});

test('changed dirty content at unchanged HEAD refuses the destructive batch', async (t) => {
  const { vars, repo, options, git } = await fixture(t);
  await writeFile(path.join(repo, 'tracked'), 'saved');
  const capture = await parkGitWork(vars, options, localExec);
  await writeFile(path.join(repo, 'tracked'), 'newer');
  await assert.rejects(
    executeParkedGitMutation(
      vars,
      { slotId: 'proof' },
      capture,
      'git reset --hard HEAD',
      localExec,
    ),
    /changed after parking/,
  );
  assert.equal(await readFile(path.join(repo, 'tracked'), 'utf8'), 'newer');
  assert.equal(git('rev-parse', capture.receipts[0].ref), capture.receipts[0].headSha);
});

test('the overwritten idle branch gets its own immutable receipt', async (t) => {
  const { vars, git, options, base } = await fixture(t);
  const feature = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('commit', '-qm', 'local main', '--allow-empty');
  const idle = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'ticket');
  const capture = await parkGitWork(
    vars,
    { ...options, extraRefs: ['refs/heads/main'] },
    localExec,
  );
  assert.deepEqual(new Set(capture.receipts.map((r) => r.headSha)), new Set([feature, idle]));
  const result = await executeParkedGitMutation(
    vars,
    { slotId: 'proof', extraRefs: ['refs/heads/main'] },
    capture,
    `git checkout main && git reset --hard '${base}'`,
    localExec,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(git('rev-parse', capture.receipts.find((r) => r.branch === 'main')!.ref), idle);
});

test('conflicted index stages survive snapshot and restore without resuming merge state', async (t) => {
  const { vars, repo, git, options, mutate } = await fixture(t);
  const base = git('hash-object', '-w', '--stdin');
  // Build all three index stages directly; a merge automation file is not part of the snapshot.
  const blob = git('rev-parse', 'HEAD:tracked');
  execFileSync('git', ['-C', repo, 'update-index', '--index-info'], {
    input: `0 ${'0'.repeat(40)}\ttracked\n100644 ${blob} 1\ttracked\n100644 ${blob} 2\ttracked\n100644 ${base} 3\ttracked\n`,
  });
  await writeFile(path.join(repo, 'tracked'), 'conflicted work');
  const stages = git('ls-files', '--stage');
  const capture = await parkGitWork(vars, options, localExec);
  await mutate(capture);
  const clean = await parkGitWork(vars, { ...options, operationKey: 'restore' }, localExec);
  await restoreParkedGitWork(vars, { slotId: 'proof' }, clean, capture.receipts[0], localExec);
  assert.equal(git('ls-files', '--stage'), stages);
  assert.equal(await readFile(path.join(repo, 'tracked'), 'utf8'), 'conflicted work');
});

test('retention uses parking age, protects required refs and never early-prunes dirty snapshots', async (t) => {
  const { vars, repo, git, options } = await fixture(t);
  const commits = await parkGitWork(vars, options, localExec);
  git('push', '-q', 'origin', 'ticket');
  await writeFile(path.join(repo, 'tracked'), 'dirty');
  const dirty = await parkGitWork(vars, options, localExec);
  const records = [...commits.receipts, ...dirty.receipts];
  const prune = (before: string, protectedRefs: string[] = []) =>
    pruneParkedGitWork(
      vars,
      'proof',
      records,
      protectedRefs,
      before,
      '2026-12-01T00:00:00Z',
      localExec,
    );
  const remote = await prune('2026-11-01T00:00:00Z');
  assert.deepEqual(
    remote.map((r) => r.ref),
    [commits.receipts[0].ref],
  );
  const kept = await readParkedGitWork(vars, 'proof', localExec);
  assert.equal(
    kept.receipts[0]?.kind,
    'worktree',
    JSON.stringify({
      dirty,
      kept,
      refs: git('for-each-ref', '--format=%(refname)', 'refs/farmslot/'),
    }),
  );
  assert.deepEqual(await prune('2026-12-01T00:00:00Z', [dirty.receipts[0].ref]), []);
  const aged = await prune('2026-12-01T00:00:00Z');
  assert.equal(aged[0].pruneReason, 'age');
  assert.equal((await readParkedGitWork(vars, 'proof', localExec)).receipts.length, 0);
});

test('an ignored file that reset would expose to clean is retained in the original snapshot', async (t) => {
  const { vars, repo, git, options, mutate } = await fixture(t);
  await writeFile(path.join(repo, '.gitignore'), '');
  git('add', '.gitignore');
  git('commit', '-qm', 'ignore baseline');
  await writeFile(path.join(repo, '.gitignore'), 'private-note\n');
  await writeFile(path.join(repo, 'private-note'), 'local note');
  const capture = await parkGitWork(vars, options, localExec);
  assert.equal(git('show', `${capture.receipts[0].ref}:private-note`), 'local note');
  await mutate(capture);
  const clean = await parkGitWork(vars, { ...options, operationKey: 'restore' }, localExec);
  await restoreParkedGitWork(vars, { slotId: 'proof' }, clean, capture.receipts[0], localExec);
  assert.equal(await readFile(path.join(repo, 'private-note'), 'utf8'), 'local note');
  assert.equal(await readFile(path.join(repo, '.gitignore'), 'utf8'), 'private-note\n');
});
