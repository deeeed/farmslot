import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecResult, Run } from '@farmslot/protocol';

import { completionVerificationMode, inspectWorktreePublishState } from './push-verification.js';

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

const result = (stdout = '', exitCode = 0, stderr = ''): ExecResult => ({
  stdout,
  stderr,
  exitCode,
});

function scriptedExecutor(results: ExecResult[]) {
  const commands: string[] = [];
  return {
    commands,
    execute: async (command: string): Promise<ExecResult> => {
      commands.push(command);
      const next = results.shift();
      assert.ok(next, `unexpected git command: ${command}`);
      return next;
    },
  };
}

test('worktree inspection counts actual content changes and untracked files NUL-safely', async () => {
  const script = scriptedExecutor([
    result(),
    result('tracked file\0shared path\0'),
    result('staged file\0shared path\0'),
    result('new file\0shared path\0'),
    result('origin/feature\n'),
    result('0\n'),
  ]);

  const state = await inspectWorktreePublishState('feature', script.execute);

  assert.deepEqual(state, {
    dirtyFiles: 4,
    trackedDirtyFiles: 3,
    untrackedFiles: 2,
    unpushedCommits: 0,
  });
  assert.deepEqual(script.commands.slice(0, 4), [
    'git rev-parse --verify --quiet HEAD',
    'git diff --name-only -z HEAD --',
    'git diff --cached --name-only -z HEAD --',
    'git ls-files --others --exclude-standard -z',
  ]);
});

test('worktree inspection supports a repository with no HEAD commit yet', async () => {
  const script = scriptedExecutor([
    result('', 1),
    result('tracked file\0'),
    result('untracked file\0'),
    result('', 1),
    result(),
    result('', 1),
  ]);

  const state = await inspectWorktreePublishState('feature', script.execute);

  assert.deepEqual(state, {
    dirtyFiles: 2,
    trackedDirtyFiles: 1,
    untrackedFiles: 1,
    unpushedCommits: 1,
  });
  assert.equal(script.commands[1], 'git ls-files --cached -z');
  assert.ok(!script.commands.some((command) => command.includes('git diff --cached')));
});

test('worktree inspection compares an existing feature remote with the local branch', async () => {
  const script = scriptedExecutor([
    result(),
    result(),
    result(),
    result(),
    result(),
    result('2\n'),
  ]);

  const state = await inspectWorktreePublishState('feature', script.execute);

  assert.deepEqual(state, {
    dirtyFiles: 0,
    trackedDirtyFiles: 0,
    untrackedFiles: 0,
    unpushedCommits: 2,
  });
  assert.equal(
    script.commands.at(-1),
    "git rev-list --count 'origin/feature'..'refs/heads/feature'",
  );
});

test('new branch inspection keeps a missing feature remote blocked at its upstream', async () => {
  const script = scriptedExecutor([
    result(),
    result(),
    result(),
    result(),
    result('', 1),
    result('origin/main\n'),
    result(),
    result('0\n'),
  ]);

  const state = await inspectWorktreePublishState('feature', script.execute);

  assert.deepEqual(state, {
    dirtyFiles: 0,
    trackedDirtyFiles: 0,
    untrackedFiles: 0,
    unpushedCommits: 1,
  });
  assert.equal(script.commands.at(-1), "git rev-list --count 'origin/main'..'refs/heads/feature'");
  assert.ok(!script.commands.includes("git rev-list --count 'refs/heads/feature'"));
});

test('new branch inspection falls back to origin HEAD when it has no upstream', async () => {
  const script = scriptedExecutor([
    result(),
    result(),
    result(),
    result(),
    result('', 1),
    result(),
    result('origin/main\n'),
    result('3\n'),
  ]);

  const state = await inspectWorktreePublishState('feature', script.execute);

  assert.deepEqual(state, {
    dirtyFiles: 0,
    trackedDirtyFiles: 0,
    untrackedFiles: 0,
    unpushedCommits: 3,
  });
  assert.equal(script.commands.at(-1), "git rev-list --count 'origin/main'..'refs/heads/feature'");
});

test('new branch inspection keeps publication blocked when no comparison ref exists', async () => {
  const script = scriptedExecutor([
    result(),
    result(),
    result(),
    result(),
    result('', 1),
    result(),
    result('', 1),
  ]);

  const state = await inspectWorktreePublishState('feature', script.execute);

  assert.deepEqual(state, {
    dirtyFiles: 0,
    trackedDirtyFiles: 0,
    untrackedFiles: 0,
    unpushedCommits: 1,
  });
  assert.ok(!script.commands.some((command) => command.startsWith('git rev-list --count')));
});

test('commit-mode inspection reports untracked leftovers without treating them as tracked dirty', async () => {
  // Run add136c6: worker committed task work but AgenticService leftovers stayed untracked.
  const script = scriptedExecutor([
    result(),
    result(), // clean tracked
    result(), // clean staged
    result('app/core/AgenticService/AgenticService.ts\0app/core/AgenticService/AgentStepHud.tsx\0'),
    result('origin/feature\n'),
    result('1\n'),
  ]);

  const state = await inspectWorktreePublishState('feature', script.execute);

  assert.equal(state.trackedDirtyFiles, 0);
  assert.equal(state.untrackedFiles, 2);
  assert.equal(state.dirtyFiles, 2);
  assert.equal(state.unpushedCommits, 1);
});
