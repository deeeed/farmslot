import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';

import { isRecord } from '@farmslot/protocol/recipe';

import type { execOnSlot } from '../core/exec.js';
import { makeVars } from '../runners/test-fixtures.js';

import {
  executeParkedGitMutation,
  executeSavedGitMutation,
  parkGitWork,
  pruneParkedGitWork,
  readParkedGitWork,
  restoreParkedGitWork,
  waitForSlotGitIndex,
} from './parked-work.js';
import { PARKED_WORK_PROGRAM } from './parked-work-program.js';

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

test('identity-free dirty capture survives reset and GC, then restores index, files and modes', async (t) => {
  const { vars, repo, git, options, mutate } = await fixture(t);
  git('config', 'user.name', '');
  git('config', 'user.email', '');
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
  assert.equal(git('config', 'user.name'), '', 'parking leaves repository identity unchanged');
  assert.equal(git('config', 'user.email'), '');
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

test('the fence between commands sees content, ignored target paths, branch tips and moved targets', async (t) => {
  const { vars, repo, options, git } = await fixture(t);
  // A target that tracks local.properties, which the checkout ignores.
  git('checkout', '-q', '-b', 'target', 'main');
  await writeFile(path.join(repo, 'local.properties'), 'tracked by the target\n');
  git('add', 'local.properties');
  git('commit', '-qm', 'target tracks it');
  const targetTree = git('rev-parse', 'target^{tree}');
  // Targets are named by a remote ref, which the branch-tip check does not cover.
  git('update-ref', 'refs/remotes/origin/target', 'target');
  git('checkout', '-q', 'ticket');
  await writeFile(path.join(repo, '.git/info/exclude'), 'local.properties\n');
  await writeFile(path.join(repo, 'tracked'), 'dirty one\n');
  const capture = await parkGitWork(
    vars,
    { ...options, targetTrees: ['origin/target'] },
    localExec,
  );
  const first = await executeParkedGitMutation(
    vars,
    { slotId: 'proof', targetTrees: ['origin/target'], stateTrees: [targetTree] },
    capture,
    'true',
    localExec,
  );
  const saved = (expectedState: string, expectedTrees: Record<string, string> = {}) =>
    executeSavedGitMutation(
      vars,
      { slotId: 'proof', stateTrees: [targetTree], expectedTrees },
      capture,
      expectedState,
      'true',
      localExec,
    );
  const changed = (error: unknown) => isRecord(error) && error.code === 'PARKED_WORK_WORK_CHANGED';
  // Unchanged: runs, and reports the same state.
  const same = await saved(first.state, { 'origin/target': targetTree });
  assert.equal(same.state, first.state);
  // Each change below is refused, then undone; the unchanged checkout runs again.
  // A dirty file edited again keeps its status line: its content still differs.
  await writeFile(path.join(repo, 'tracked'), 'dirty two\n');
  await assert.rejects(saved(first.state), changed);
  await writeFile(path.join(repo, 'tracked'), 'dirty one\n');
  // A new ignored file that a target tracks.
  await writeFile(path.join(repo, 'local.properties'), 'written later\n');
  await assert.rejects(saved(first.state), changed);
  await rm(path.join(repo, 'local.properties'));
  // A branch tip moved by someone else.
  const main = git('rev-parse', 'main');
  git('branch', '-f', 'main', 'target');
  await assert.rejects(saved(first.state), changed);
  git('branch', '-f', 'main', main);
  // A target name that now resolves to another tree.
  git('update-ref', 'refs/remotes/origin/target', main);
  await assert.rejects(saved(first.state, { 'origin/target': targetTree }), changed);
  // An ignored directory standing where a target tracks a file.
  await mkdir(path.join(repo, 'local.properties'));
  await assert.rejects(saved(first.state), changed);
  await rm(path.join(repo, 'local.properties'), { recursive: true });
  // An ignored file HEAD's rules would expose to clean: only an untracked .gitignore hides it.
  await writeFile(path.join(repo, '.gitignore'), 'private-note\n');
  await writeFile(path.join(repo, 'private-note'), 'one\n');
  const exposedState = (
    await executeParkedGitMutation(
      vars,
      { slotId: 'proof', stateTrees: [targetTree] },
      await parkGitWork(vars, { ...options, targetTrees: ['origin/target'] }, localExec),
      'true',
      localExec,
    )
  ).state;
  await writeFile(path.join(repo, 'private-note'), 'two\n');
  await assert.rejects(saved(exposedState), changed);
  await rm(path.join(repo, 'private-note'));
  await rm(path.join(repo, '.gitignore'));
  // A new untracked file.
  await writeFile(path.join(repo, 'stray'), 'written by someone else\n');
  await assert.rejects(saved(first.state), changed);
  await rm(path.join(repo, 'stray'));
  // The sequence's own command runs and hands the next one its new state.
  const next = await executeSavedGitMutation(
    vars,
    { slotId: 'proof', stateTrees: [targetTree] },
    capture,
    first.state,
    'git reset -q --hard HEAD',
    localExec,
  );
  assert.equal(next.exitCode, 0, next.stderr);
  assert.notEqual(next.state, first.state);
  // A missing saved snapshot refuses before anything runs.
  git('update-ref', '-d', capture.receipts[0].ref);
  await assert.rejects(
    saved(next.state),
    (error: unknown) => isRecord(error) && error.code === 'PARKED_WORK_SNAPSHOT_MISSING',
  );
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

test('retention keeps unknown promisor ancestry local and still prunes verified remote work', async (t) => {
  const { root, repo, vars, git, options } = await fixture(t);
  const capture = await parkGitWork(vars, options, localExec);
  const receipt = capture.receipts[0];
  const remote = path.join(root, 'remote.git');
  git('push', '-q', 'origin', 'HEAD:refs/heads/published');
  const intermediate = execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '--git-dir=' + remote,
      'commit-tree',
      git('rev-parse', 'HEAD^{tree}'),
      '-p',
      receipt.headSha,
    ],
    { input: 'unfetched intermediate\n', encoding: 'utf8' },
  ).trim();
  const next = execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '--git-dir=' + remote,
      'commit-tree',
      git('rev-parse', 'HEAD^{tree}'),
      '-p',
      intermediate,
    ],
    { input: 'unfetched remote tip\n', encoding: 'utf8' },
  ).trim();
  execFileSync('git', ['--git-dir=' + remote, 'update-ref', 'refs/heads/published', next]);
  execFileSync('git', ['--git-dir=' + remote, 'config', 'uploadpack.allowFilter', 'true']);
  git('config', 'remote.origin.promisor', 'true');
  git('config', 'remote.origin.partialclonefilter', 'blob:none');
  git('config', 'extensions.partialClone', 'origin');
  const missing = execFileSync(
    'git',
    ['-C', repo, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
    { input: next + '\n', encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } },
  );
  assert.match(missing, / missing/);
  const trace = path.join(root, 'retention.trace');
  const tracedExec: typeof execOnSlot = async (_vars, command) => {
    const result = await execute('bash', ['-c', command], {
      env: { ...process.env, GIT_TRACE: trace },
    });
    return { ...result, exitCode: 0 };
  };
  const prune = (protectedRefs: string[] = []) =>
    pruneParkedGitWork(
      vars,
      'proof',
      capture.receipts,
      protectedRefs,
      '2026-11-01T00:00:00Z',
      '2026-11-14T00:00:00Z',
      tracedExec,
    );
  const unknown = await prune();
  const observed = await readFile(trace, 'utf8');
  assert.doesNotMatch(
    observed,
    /fetch origin/,
    'a passive retention lookup must not fetch missing tips',
  );
  assert.match(observed, /ls-remote --heads origin/, 'advertisement must still be fresh');
  assert.deepEqual(unknown, []);
  assert.equal(git('rev-parse', receipt.ref), receipt.headSha);
  // A locally cached remote tip can still have an unfetched promisor parent.
  const tipBytes = execFileSync('git', ['--git-dir=' + remote, 'cat-file', 'commit', next]);
  execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: tipBytes,
  });
  assert.deepEqual(await prune(), []);
  assert.doesNotMatch(await readFile(trace, 'utf8'), /fetch origin/);
  assert.equal(git('rev-parse', receipt.ref), receipt.headSha);
  // Explicit acting fetch remains allowed and turns the unknown ancestry into a verified proof.
  git('fetch', '-q', 'origin');
  assert.deepEqual(await prune([receipt.ref]), []);
  assert.equal(git('rev-parse', receipt.ref), receipt.headSha);
  const published = await prune();
  assert.equal(published[0]?.ref, receipt.ref);
  assert.equal(published[0]?.pruneReason, 'remote');
});

test('an index lock that does not settle is retained with a bounded busy error', async (t) => {
  const { repo, git, options } = await fixture(t);
  const lock = path.join(repo, '.git/index.lock');
  await writeFile(lock, 'unknown-owner');
  const refs = git('for-each-ref', '--format=%(refname) %(objectname)');
  let clock = 0;
  let output = '';
  class ClockDate extends Date {
    static now() {
      return clock;
    }
  }
  vm.runInNewContext(PARKED_WORK_PROGRAM, {
    require: createRequire(import.meta.url),
    Buffer,
    Date: ClockDate,
    Atomics: {
      wait: (_array: Int32Array, _index: number, _value: number, delay: number) => {
        clock += delay;
        return 'timed-out';
      },
    },
    process: {
      argv: ['node', JSON.stringify({ ...options, repo, op: 'waitIndex' })],
      env: process.env,
      stdout: {
        write: (text: string) => {
          output += text;
        },
      },
      stderr: { write: () => {} },
    },
  });
  const result: unknown = JSON.parse(output);
  assert.ok(isRecord(result));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_BUSY');
  assert.match(String(result.message), /index\.lock.*60000ms/);
  assert.equal(clock, 60000);
  assert.equal(await readFile(lock, 'utf8'), 'unknown-owner');
  assert.equal(git('for-each-ref', '--format=%(refname) %(objectname)'), refs);
});

test('prepare-style checkout waits for the preceding Git index writer', async (t) => {
  const { vars, repo, git, options } = await fixture(t);
  // The release's Git work has returned the checkout to its idle branch.
  git('checkout', '-q', 'main');
  const holder = spawn('git', ['-C', repo, 'update-index', '--index-info']);
  const closed = new Promise<void>((resolve) => holder.once('close', () => resolve()));
  t.after(async () => {
    if (!holder.stdin.writableEnded) holder.stdin.end();
    await closed;
  });
  const indexLock = path.join(repo, '.git/index.lock');
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(path.dirname(indexLock), () => {
      if (existsSync(indexLock)) resolve();
    });
    watcher.once('error', reject);
    t.after(() => watcher.close());
    holder.once('error', reject);
    holder.once('close', () => reject(new Error('Git exited before its index lock was observed')));
    if (existsSync(indexLock)) resolve();
    else if (holder.exitCode !== null) reject(new Error('Git index writer already exited'));
  });
  let observedWait = false;
  let originalLockPreserved = false;
  const waitingExec: typeof execOnSlot = async (_vars, command) => {
    const pending = execute('bash', ['-c', command]);
    pending.child.stderr?.on('data', (chunk) => {
      if (!observedWait && String(chunk).includes('Waiting for Git index lock')) {
        observedWait = true;
        originalLockPreserved = existsSync(indexLock) && holder.exitCode === null;
        holder.stdin.end();
      }
    });
    const result = await pending;
    return { ...result, exitCode: 0 };
  };
  await waitForSlotGitIndex(vars, waitingExec);
  const capture = await parkGitWork(vars, options, waitingExec);
  const result = await executeParkedGitMutation(
    vars,
    { slotId: 'proof' },
    capture,
    `git checkout ticket`,
    waitingExec,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(observedWait, 'the checkout waits instead of failing on the preceding writer');
  assert.ok(originalLockPreserved, 'the waiter never deletes a live writer lock');
  assert.equal(git('branch', '--show-current'), 'ticket');
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

// mini-mm-3 (run fcfb5124): a clean checkout was saved as a dirty working tree on every park.
test('a clean checkout whose ignored folders hide only their contents parks no working tree', async (t) => {
  const { vars, repo, git, options } = await fixture(t);
  await writeFile(path.join(repo, '.gitignore'), '.agents/skills/\n');
  git('add', '.gitignore');
  git('commit', '-qm', 'ignore skills');
  // A rule that ignores paths inside a folder: Git lists the whole folder as ignored.
  await mkdir(path.join(repo, '.agents', 'skills', 'recipe'), { recursive: true });
  await writeFile(path.join(repo, '.agents', 'skills', 'recipe', 'SKILL.md'), 'skill\n');
  // An untracked rule file that ignores itself, as husky writes: clean keeps it and its rules.
  await mkdir(path.join(repo, '.husky', '_'), { recursive: true });
  await writeFile(path.join(repo, '.husky', '_', '.gitignore'), '*\n');
  await writeFile(path.join(repo, '.husky', '_', 'h'), 'hook\n');
  const capture = await parkGitWork(vars, options, localExec);
  assert.deepEqual(
    capture.receipts.map((receipt) => receipt.kind),
    ['commits'],
  );
});

test('restore evaluates ignored paths before and after checkout without sharing temporary rule state', async (t) => {
  const { vars, repo, git, options } = await fixture(t);
  await writeFile(path.join(repo, '.gitignore'), 'ignored-note\n');
  git('add', '.gitignore');
  git('commit', '-qm', 'stable ignore rules');
  await writeFile(path.join(repo, 'ignored-note'), 'must stay untouched');
  await writeFile(path.join(repo, 'tracked'), 'restored working content');
  const saved = await parkGitWork(vars, options, localExec);
  const restored = await restoreParkedGitWork(
    vars,
    { slotId: 'proof' },
    saved,
    saved.receipts[0],
    localExec,
  );
  assert.match(restored.branch, /^restored\//);
  assert.equal(await readFile(path.join(repo, 'tracked'), 'utf8'), 'restored working content');
  assert.equal(await readFile(path.join(repo, 'ignored-note'), 'utf8'), 'must stay untouched');
});
