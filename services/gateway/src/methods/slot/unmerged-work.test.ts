import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublishedPrepareBranchContained } from './unmerged-work.js';
import { bash, BRANCH, commit, git, slotRepo } from './unmerged-work.test-support.js';

test('published unique worker commits block replacement and are named without moving refs', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const first = git(repo, 'rev-parse', '--short', 'HEAD');
  commit(repo, 'second-worker.txt');
  const second = git(repo, 'rev-parse', '--short', 'HEAD');
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(
    assertPublishedPrepareBranchContained(vars, BRANCH, ['origin/main'], bash),
    (error: Error) => {
      assert.match(error.message, /refused to replace published branch/);
      assert.ok(error.message.includes(first));
      assert.ok(error.message.includes(second));
      return true;
    },
  );
  assert.equal(git(repo, 'rev-parse', BRANCH), head);
  assert.equal(git(repo, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split(/\s/)[0], head);
});

test('a published branch contained in default or recorded start ref may be replaced', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  const startRef = git(repo, 'rev-parse', BRANCH);
  await assertPublishedPrepareBranchContained(vars, BRANCH, ['origin/main', startRef], bash);
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '--ff-only', BRANCH);
  git(repo, 'push', '-q', 'origin', 'main');
  await assertPublishedPrepareBranchContained(vars, BRANCH, ['origin/main'], bash);
  await assert.rejects(
    assertPublishedPrepareBranchContained(vars, BRANCH, ['missing-base'], bash),
    /Cannot verify published branch/,
  );
});
