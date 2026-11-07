import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { GIT_DIFF_COMMAND } from '@farmslot/agent-runtime/scripts/git-diff.cjs';
import type { ExecResult, Run } from '@farmslot/protocol';

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

test('artifact-only output is retained without commit or publication verification', () => {
  // a65e9a6a followed the comparison guardrails and left four tracked edits.
  for (const flowType of ['dev', 'fix-bug', 'pr-complete', 'update-branch'] as const)
    for (const lane of ['comparison', 'validation', 'production'] as const) {
      const run = shape({ flowType, completionPolicy: 'artifact-only', lane });
      assert.equal(completionVerificationMode(run), 'none', `${flowType}/${lane}`);
    }
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
      remoteChecked: false,
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
      remoteChecked: false,
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
      remoteChecked: false,
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
      remoteChecked: false,
    });
  });

  test(`${name}: new branch inspection keeps a missing feature remote blocked at its upstream`, async (t) => {
    const repo = repository(t);
    repo.commit('chore: history');
    repo.git('update-ref', 'refs/remotes/origin/main', repo.commit('chore: main'));
    // An origin that cannot be read, without a DNS lookup.
    repo.git('remote', 'add', 'origin', path.join(tempDir(t), 'missing.git'));
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

  test(`${name}: a renamed run branch reads as off-branch instead of failing rev-list`, async (t) => {
    // F327: a worker ran `git branch -m` to put DO NOT MERGE in the name; comparing the
    // missing refs/heads/feature against origin/feature failed with exit 128.
    const repo = repository(t);
    repo.git('update-ref', 'refs/remotes/origin/feature', repo.commit('feat: pushed'));
    repo.commit('feat: one');
    repo.git('branch', '-m', 'feature', 'do-not-merge-feature');

    for (const mode of ['push', 'commit'] as const) {
      const { state } = await inspect(repo.dir, mode);
      assert.deepEqual(state.offBranch, { runBranchExists: false, head: 'do-not-merge-feature' });
      assert.equal(stateSatisfiesMode(state, mode), false);
    }
  });

  test(`${name}: HEAD on another branch or detached reads as off-branch`, async (t) => {
    const repo = repository(t);
    repo.git('update-ref', 'refs/remotes/origin/feature', repo.commit('feat: pushed'));
    repo.git('checkout', '-q', '-b', 'other');
    repo.commit('feat: on the wrong branch');
    let { state } = await inspect(repo.dir, 'push');
    assert.deepEqual(state.offBranch, { runBranchExists: true, head: 'other' });
    assert.equal(stateSatisfiesMode(state, 'push'), false);

    repo.git('checkout', '-q', '--detach');
    ({ state } = await inspect(repo.dir, 'push'));
    assert.deepEqual(state.offBranch, { runBranchExists: true, head: null });
  });

  test(`${name}: a renamed run branch the remote still has is reported before the remote comparison`, async (t) => {
    const repo = mainOnlyClone(t);
    repo.commit('feat: one');
    repo.git('push', '-q', 'origin', 'feature');
    repo.git('branch', '-m', 'feature', 'do-not-merge-feature');

    const { state } = await inspect(repo.dir, 'push');

    assert.deepEqual(state.offBranch, { runBranchExists: false, head: 'do-not-merge-feature' });
    assert.equal(state.remoteChecked, undefined);
  });

  test(`${name}: new branch inspection keeps publication blocked when no comparison ref exists`, async (t) => {
    const repo = repository(t);
    repo.commit('feat: one');
    repo.commit('feat: two');

    assert.equal((await inspect(repo.dir, 'push')).state.unpushedCommits, 1);
  });

  // F326 (#298): the slot clone fetches main only, so a push never moves origin/<branch>.
  test(`${name}: a pushed branch verifies against the remote, not a stale origin ref`, async (t) => {
    const repo = mainOnlyClone(t);
    const stale = repo.commit('feat: pushed earlier');
    repo.git('update-ref', 'refs/remotes/origin/feature', stale);
    repo.commit('feat: one');
    repo.commit('feat: two');
    repo.git('push', '-q', 'origin', 'feature');
    assert.equal(repo.git('rev-parse', 'refs/remotes/origin/feature'), stale);

    const { state } = await inspect(repo.dir, 'push');
    assert.equal(state.unpushedCommits, 0);
    assert.equal(state.remoteChecked, true);
    repo.commit('feat: three');
    assert.equal((await inspect(repo.dir, 'push')).state.unpushedCommits, 1);
    // Commit mode never contacts the remote.
    assert.doesNotMatch((await inspect(repo.dir, 'commit')).command, /ls-remote|fetch/);
  });

  test(`${name}: a remote branch ahead of the clone is fetched before counting`, async (t) => {
    const repo = mainOnlyClone(t);
    repo.commit('feat: one');
    repo.git('push', '-q', 'origin', 'feature');
    pushElsewhere(t, repo.remote);

    assert.equal((await inspect(repo.dir, 'push')).state.unpushedCommits, 0);
    // Counted from the fetched remote tip: a local commit beside it is unpushed.
    repo.commit('feat: two');
    assert.equal((await inspect(repo.dir, 'push')).state.unpushedCommits, 1);
  });

  test(`${name}: a remote commit the fetch cannot bring falls back to the local comparison`, async (t) => {
    const repo = mainOnlyClone(t);
    const pushed = repo.commit('feat: one');
    repo.git('push', '-q', 'origin', 'feature');
    pushElsewhere(t, repo.remote);
    repo.git('update-ref', 'refs/remotes/origin/feature', pushed);
    repo.commit('feat: two');
    serveOrigin(t, repo, '[ "$n" = 2 ] && exit 1');

    const { state } = await inspect(repo.dir, 'push');

    assert.equal(state.unpushedCommits, 1);
    assert.equal(state.remoteChecked, false);
  });

  test(`${name}: a branch force-pushed between the probe and the fetch falls back to the local comparison`, async (t) => {
    const repo = mainOnlyClone(t);
    const pushed = repo.commit('feat: one');
    repo.git('push', '-q', 'origin', 'feature');
    pushElsewhere(t, repo.remote);
    repo.commit('feat: two');
    // ls-remote advertises the commit from elsewhere; the fetch then finds `pushed`.
    serveOrigin(
      t,
      repo,
      `[ "$n" = 2 ] && git --git-dir='${repo.remote}' update-ref refs/heads/feature ${pushed}`,
    );

    const { state } = await inspect(repo.dir, 'push');

    assert.equal(state.unpushedCommits, 1);
    assert.equal(state.remoteChecked, false);
  });

  test(`${name}: a branch the remote no longer has stays unpublished despite a matching stale ref`, async (t) => {
    const repo = mainOnlyClone(t);
    repo.git('update-ref', 'refs/remotes/origin/feature', repo.commit('feat: one'));

    const { state } = await inspect(repo.dir, 'push');

    assert.equal(state.unpushedCommits, 1);
    assert.equal(state.remoteChecked, true);
  });
}

/** A repository whose origin is a real bare remote fetched for main only, like a slot clone. */
function mainOnlyClone(t: TestContext) {
  const repo = repository(t);
  const remote = tempDir(t);
  execFileSync('git', ['init', '-q', '--bare', remote], { env: gitEnv });
  repo.git('remote', 'add', 'origin', remote);
  repo.git('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  return { ...repo, remote };
}

/** Push one commit on top of the remote's feature branch from another clone. */
function pushElsewhere(t: TestContext, remote: string) {
  const other = tempDir(t);
  execFileSync('git', ['clone', '-q', '-b', 'feature', remote, other], { env: gitEnv });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: other, env: gitEnv });
  git(
    '-c',
    'user.name=Other',
    '-c',
    'user.email=other@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'feat: from elsewhere',
  );
  git('push', '-q', 'origin', 'feature');
}

/**
 * Run `hook` before each upload-pack the clone starts against origin, with the
 * call number in `$n`: 1 is the ls-remote probe, 2 the fetch.
 */
function serveOrigin(t: TestContext, repo: ReturnType<typeof repository>, hook: string) {
  const script = path.join(tempDir(t), 'upload-pack');
  writeFileSync(
    script,
    `#!/bin/sh\nn=$(($(cat "$0.n" 2>/dev/null || echo 0) + 1)); echo "$n" >"$0.n"\n${hook}\nexec git upload-pack "$@"\n`,
    { mode: 0o755 },
  );
  repo.git('config', 'remote.origin.uploadpack', script);
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

test('a push inspection that timed out retries without asking the remote, even past its deadline', async (t) => {
  // A stalled connection to the remote outlives the exec timeout. The retry
  // compares with local refs and says so, also during the nudge wait's last
  // recheck, so the run blocks instead of failing.
  const repo = repository(t);
  repo.git('update-ref', 'refs/remotes/origin/feature', repo.commit('feat: task'));
  const slot = shellExecutor(repo.dir);
  const commands: string[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = inspectWorktreeWithRetry(
    'feature',
    'push',
    async (command) => {
      commands.push(command);
      return commands.length === 1 ? TIMED_OUT : slot.execute(command);
    },
    Date.now(),
  );
  await settle();
  t.mock.timers.tick(5_000);
  const state = await pending;

  assert.match(commands[0], /ls-remote/);
  assert.doesNotMatch(commands[1], /ls-remote/);
  assert.ok(state !== 'aborted' && stateSatisfiesMode(state, 'push'));
  assert.equal(state.remoteChecked, false);
});

test('a push inspection past its deadline fails once its local retry also times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands: string[] = [];

  const rejected = assert.rejects(
    inspectWorktreeWithRetry(
      'feature',
      'push',
      async (command) => {
        commands.push(command);
        return TIMED_OUT;
      },
      Date.now(),
    ),
    /push-verification worktree inspection failed \(exit 124\)/,
  );
  await settle();
  t.mock.timers.tick(5_000);
  await rejected;

  assert.equal(commands.length, 2);
  assert.doesNotMatch(commands[1], /ls-remote/);
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
