import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { GIT_DIFF_COMMAND } from '@farmslot/agent-runtime/scripts/git-diff.cjs';
import type { ExecResult, Run } from '@farmslot/protocol';

import { runContractSection } from '../tasks/run-contract.js';

import {
  completionVerificationMode,
  inspectWorktreePublishState,
  inspectWorktreeWithRetry,
  stateSatisfiesMode,
} from './push-verification.js';

const shape = (over: Partial<Run>): Run =>
  ({ flowType: 'dev', mode: 'autonomous', ...over }) as Run;

test('worker-owned-push flows require a published branch', () => {
  assert.equal(completionVerificationMode(shape({ flowType: 'pr-complete' })), 'push');
  assert.equal(completionVerificationMode(shape({ flowType: 'update-branch' })), 'push');
});

test('autonomous dev requires a commit but not a push', () => {
  // The publication step performs the push, so requiring one here would fire
  // before it is meant to. Uncommitted work is the real loss: it exists only in
  // the slot worktree. Run 32909fa2 completed with 26 files uncommitted.
  assert.equal(completionVerificationMode(shape({ flowType: 'dev' })), 'commit');
});

test('an artifact-only dev run that must commit is told to commit', () => {
  // Stability run ef32f8e7 (validation lane, artifact-only) got no commit rule in
  // TASK.md, followed its skill's "commit only when requested", and was blocked here.
  const run = shape({ flowType: 'dev', completionPolicy: 'artifact-only', lane: 'validation' });
  assert.equal(completionVerificationMode(run), 'commit');
  assert.match(runContractSection(run, 'temp/tasks/t') ?? '', /Commit the change locally/);
});

test('interactive dev is operator-owned and verified elsewhere', () => {
  // The template tells the worker to keep changes local unless told otherwise, so
  // neither a commit nor a push can be demanded of it here.
  assert.equal(
    completionVerificationMode(
      shape({ flowType: 'dev', mode: 'interactive', devInteractiveProfile: 'lightweight' }),
    ),
    'none',
  );
  assert.equal(
    completionVerificationMode(
      shape({ flowType: 'dev', mode: 'interactive', devInteractiveProfile: 'reviewed' }),
    ),
    'none',
  );
});

test('unrelated flows are not gated', () => {
  assert.equal(completionVerificationMode(shape({ flowType: 'fix-bug' })), 'none');
  assert.equal(completionVerificationMode(shape({ flowType: 'review-pr' })), 'none');
});

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  // A directory that is not a repository must not find one above the temp dir.
  GIT_CEILING_DIRECTORIES: realpathSync(os.tmpdir()),
};
// Slot hosts run the inspection through bash locally and zsh on macOS nodes.
const SHELLS = [
  ['bash', '-c'],
  ['zsh', '-f', '-c'],
].filter(([shell]) => spawnSync(shell, ['-c', 'true']).status === 0);

function shellExecutor(cwd: string, [shell, ...flags] = SHELLS[0]) {
  const commands: string[] = [];
  return {
    commands,
    execute: async (command: string): Promise<ExecResult> => {
      commands.push(command);
      const { stdout, stderr, status } = spawnSync(shell, [...flags, command], {
        cwd,
        env: gitEnv,
        encoding: 'utf8',
      });
      return { stdout, stderr, exitCode: status ?? 1 };
    },
  };
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'push-verification-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repository(t: TestContext) {
  const dir = tempDir(t);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature');
  git('config', 'user.name', 'Push verification');
  git('config', 'user.email', 'push-verification@example.invalid');
  return {
    dir,
    git,
    write: (file: string, text = file) => writeFileSync(path.join(dir, file), text),
    commit: (message: string) => {
      git('commit', '-q', '--allow-empty', '-m', message);
      return git('rev-parse', 'HEAD');
    },
  };
}

for (const shell of SHELLS) {
  const name = shell[0];
  const inspect = async (dir: string, mode: 'push' | 'commit') => {
    const executor = shellExecutor(dir, shell);
    const state = await inspectWorktreePublishState('feature', mode, executor.execute);
    // Every probe runs in one slot exec.
    assert.equal(executor.commands.length, 1);
    return { state, command: executor.commands[0] };
  };

  test(`${name}: push-mode inspection counts content changes and untracked files NUL-safely in one exec`, async (t) => {
    const repo = repository(t);
    for (const file of ['tracked file', 'staged file', 'shared path']) repo.write(file);
    repo.git('add', '-A');
    repo.git('update-ref', 'refs/remotes/origin/feature', repo.commit('feat: base'));
    repo.write('tracked file', 'changed');
    repo.write('staged file', 'changed');
    repo.write('shared path', 'staged');
    repo.git('add', 'staged file', 'shared path');
    repo.write('shared path', 'changed again');
    repo.write('new file');
    repo.write('odd\nname');

    const { state, command } = await inspect(repo.dir, 'push');

    assert.deepEqual(state, {
      dirtyFiles: 5,
      trackedDirtyFiles: 3,
      untrackedFiles: 2,
      unpushedCommits: 0,
    });
    for (const probe of [
      `${GIT_DIFF_COMMAND} --name-only -z HEAD --`,
      `${GIT_DIFF_COMMAND} --cached --name-only -z HEAD --`,
      'git ls-files --others --exclude-standard -z',
    ])
      assert.ok(command.includes(probe), probe);
  });

  test(`${name}: push mode still blocks on untracked files`, async (t) => {
    const repo = repository(t);
    repo.git('update-ref', 'refs/remotes/origin/feature', repo.commit('feat: task'));
    repo.write('leftover.ts');

    const { state } = await inspect(repo.dir, 'push');

    assert.deepEqual(state, {
      dirtyFiles: 1,
      trackedDirtyFiles: 0,
      untrackedFiles: 1,
      unpushedCommits: 0,
    });
    assert.equal(stateSatisfiesMode(state, 'push'), false);
  });

  test(`${name}: commit-mode inspection does not walk untracked leftovers`, async (t) => {
    // Run add136c6: worker committed task work but AgenticService leftovers stayed
    // untracked. They cannot block commit mode, so the inspection never lists them.
    const repo = repository(t);
    repo.commit('feat: task');
    mkdirSync(path.join(repo.dir, 'app'));
    repo.write('app/AgenticService.ts');
    repo.write('app/AgentStepHud.tsx');

    const { state, command } = await inspect(repo.dir, 'commit');

    assert.ok(!command.includes('ls-files --others'));
    assert.deepEqual(state, { dirtyFiles: 0, trackedDirtyFiles: 0, unpushedCommits: 1 });
    assert.equal(stateSatisfiesMode(state, 'commit'), true);
  });

  test(`${name}: worktree inspection supports a repository with no HEAD commit yet`, async (t) => {
    const repo = repository(t);
    repo.write('tracked file');
    repo.git('add', 'tracked file');
    repo.write('untracked file');

    const { state } = await inspect(repo.dir, 'push');

    assert.deepEqual(state, {
      dirtyFiles: 2,
      trackedDirtyFiles: 1,
      untrackedFiles: 1,
      unpushedCommits: 1,
    });
  });

  test(`${name}: worktree inspection compares an existing feature remote with the local branch`, async (t) => {
    const repo = repository(t);
    repo.git('update-ref', 'refs/remotes/origin/feature', repo.commit('feat: pushed'));
    repo.commit('feat: one');
    repo.commit('feat: two');

    const { state } = await inspect(repo.dir, 'push');

    assert.deepEqual(state, {
      dirtyFiles: 0,
      trackedDirtyFiles: 0,
      untrackedFiles: 0,
      unpushedCommits: 2,
    });
  });

  test(`${name}: new branch inspection keeps a missing feature remote blocked at its upstream`, async (t) => {
    const repo = repository(t);
    repo.commit('chore: history');
    repo.git('update-ref', 'refs/remotes/origin/main', repo.commit('chore: main'));
    repo.git('remote', 'add', 'origin', 'https://example.invalid/repo.git');
    repo.git('config', 'branch.feature.remote', 'origin');
    repo.git('config', 'branch.feature.merge', 'refs/heads/main');

    // Level with its upstream is still unpublished, and never the whole history (2).
    assert.equal((await inspect(repo.dir, 'push')).state.unpushedCommits, 1);
    repo.commit('feat: one');
    repo.commit('feat: two');
    assert.equal((await inspect(repo.dir, 'push')).state.unpushedCommits, 2);
  });

  test(`${name}: new branch inspection falls back to origin HEAD when it has no upstream`, async (t) => {
    const repo = repository(t);
    repo.git('update-ref', 'refs/remotes/origin/main', repo.commit('chore: main'));
    repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    for (const n of [1, 2, 3]) repo.commit(`feat: ${n}`);

    assert.equal((await inspect(repo.dir, 'push')).state.unpushedCommits, 3);
  });

  test(`${name}: new branch inspection keeps publication blocked when no comparison ref exists`, async (t) => {
    const repo = repository(t);
    repo.commit('feat: one');
    repo.commit('feat: two');

    assert.equal((await inspect(repo.dir, 'push')).state.unpushedCommits, 1);
  });
}

const TIMED_OUT: ExecResult = {
  stdout: '',
  stderr: '\ncommand timed out after 30000ms',
  exitCode: 124,
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('an inspection that timed out once is retried and verifies', async (t) => {
  // Run e4d0cc24: the worker had finished, but its briefly overloaded slot host
  // timed the untracked probe out at 30 s. It answered in under a second later.
  const repo = repository(t);
  repo.commit('feat: task');
  const slot = shellExecutor(repo.dir);
  let execs = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = inspectWorktreeWithRetry(
    'feature',
    'commit',
    async (command) => (++execs === 1 ? TIMED_OUT : slot.execute(command)),
    Date.now() + 60_000,
  );
  await settle();
  t.mock.timers.tick(5_000);
  const state = await pending;

  assert.ok(state !== 'aborted' && stateSatisfiesMode(state, 'commit'));
  assert.equal(execs, 2);
});

test('an inspection that keeps timing out fails with the probe message at its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let execs = 0;

  const rejected = assert.rejects(
    inspectWorktreeWithRetry(
      'feature',
      'commit',
      async () => {
        execs++;
        return TIMED_OUT;
      },
      Date.now() + 12_000,
    ),
    {
      message:
        'push-verification worktree inspection failed (exit 124): \ncommand timed out after 30000ms',
    },
  );
  await settle();
  // The second attempt cannot wait another 10 s before the deadline.
  t.mock.timers.tick(5_000);
  await rejected;

  assert.equal(execs, 2);
});

test('a thrown exec after a timed-out attempt fails at once instead of retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let execs = 0;

  const rejected = assert.rejects(
    inspectWorktreeWithRetry(
      'feature',
      'commit',
      async () => {
        if (++execs === 1) return TIMED_OUT;
        throw new Error('node transport closed');
      },
      Date.now() + 60_000,
    ),
    /node transport closed/,
  );
  await settle();
  t.mock.timers.tick(5_000);
  await rejected;

  assert.equal(execs, 2);
});

test('a git error fails the inspection at once without a retry', async (t) => {
  const slot = shellExecutor(tempDir(t));

  await assert.rejects(
    inspectWorktreeWithRetry('feature', 'commit', slot.execute, Date.now() + 60_000),
    /push-verification HEAD probe failed \(exit 128\): fatal: not a git repository/,
  );

  assert.equal(slot.commands.length, 1);
});

test('a cancel during the retry wait returns aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let execs = 0;

  const pending = inspectWorktreeWithRetry(
    'feature',
    'commit',
    async () => {
      execs++;
      return TIMED_OUT;
    },
    Date.now() + 60_000,
    controller.signal,
  );
  await settle();
  controller.abort();

  assert.equal(await pending, 'aborted');
  assert.equal(execs, 1);
});
