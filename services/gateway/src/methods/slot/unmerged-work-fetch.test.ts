import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { assertPrepareCommitsPublished } from './unmerged-work.js';
import {
  bash,
  BRANCH,
  commit,
  git,
  slotRepo,
  squashAndPrune,
} from './unmerged-work.test-support.js';

function deletedSingleBranch(t: test.TestContext) {
  const fixture = slotRepo(t, ['origin']);
  const merged = squashAndPrune(fixture.repo);
  // Terminal #277 left a single-branch fetch refspec naming its deleted PR head.
  git(fixture.repo, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  git(
    fixture.repo,
    'config',
    '--add',
    'remote.origin.fetch',
    `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`,
  );
  git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', `${merged.mergeSha}^`);
  return { ...fixture, merged };
}

test('prepare verifies the merged PR head when a deleted single-branch refspec blocks fetch', async (t) => {
  const { repo, vars, merged } = deletedSingleBranch(t);
  const before = git(repo, 'show-ref', '--heads');
  const configured = git(repo, 'config', '--get-all', 'remote.origin.fetch');
  const failed = await bash(vars, `git -C '${repo}' fetch --all --no-prune --no-tags`);
  assert.notEqual(failed.exitCode, 0);
  assert.match(failed.stderr, /couldn't find remote ref refs\/heads\//);
  let reads = 0;
  await assertPrepareCommitsPublished(
    vars,
    'next-run',
    bash,
    { githubRepo: 'example/app' },
    async (repository, head, _timeout, _force, headBranch) => {
      assert.equal(repository, 'example/app');
      assert.equal(head, merged.headSha);
      assert.equal(headBranch, BRANCH);
      reads++;
      return [merged];
    },
  );
  assert.equal(reads, 1);
  assert.equal(git(repo, 'rev-parse', 'origin/main'), merged.mergeSha);
  assert.equal(git(repo, 'show-ref', '--heads'), before);
  assert.equal(git(repo, 'config', '--get-all', 'remote.origin.fetch'), configured);
});

for (const reason of [
  'unmerged PR',
  'unavailable PR',
  'new local commit',
  'merge outside default',
]) {
  test(`deleted-ref recovery refuses ${reason} and preserves local branches`, async (t) => {
    const { repo, vars, merged } = deletedSingleBranch(t);
    if (reason === 'new local commit') commit(repo, 'unpublished-after-merge.txt');
    const before = git(repo, 'show-ref', '--heads');
    const head = git(repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      assertPrepareCommitsPublished(
        vars,
        'next-run',
        bash,
        { githubRepo: 'example/app' },
        async () => {
          if (reason === 'unavailable PR') throw new Error('GitHub unavailable');
          if (reason === 'unmerged PR') return [];
          return [
            { ...merged, baseBranch: reason === 'merge outside default' ? 'release' : 'main' },
          ];
        },
      ),
      (error: Error) => {
        assert.match(error.message, /Cannot verify remote commits.*branches untouched/s);
        if (reason === 'unmerged PR') {
          assert.ok(error.message.includes(`No merged PR into main contains refs/heads/${BRANCH}`));
          assert.equal(error.message.split('Cannot verify remote commits').length, 2);
        }
        return true;
      },
    );
    assert.equal(git(repo, 'show-ref', '--heads'), before);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  });
}

test('deleted-ref recovery refuses dirty files even if old tracking refs retain the tip', async (t) => {
  const { repo, vars, merged } = deletedSingleBranch(t);
  git(repo, 'update-ref', `refs/remotes/origin/${BRANCH}`, merged.headSha);
  writeFileSync(path.join(repo, 'operator-notes.txt'), 'keep me\n');
  await assert.rejects(
    assertPrepareCommitsPublished(
      vars,
      'next-run',
      bash,
      { githubRepo: 'example/app' },
      async () => [merged],
    ),
    /dirty files/,
  );
  assert.equal(readFileSync(path.join(repo, 'operator-notes.txt'), 'utf8'), 'keep me\n');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), merged.headSha);
});

test('a failing second remote cannot be hidden by a merged deleted origin branch', async (t) => {
  const { repo, vars, merged } = deletedSingleBranch(t);
  git(repo, 'remote', 'add', 'other', path.join(repo, 'missing.git'));
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(
    assertPrepareCommitsPublished(
      vars,
      'next-run',
      bash,
      { githubRepo: 'example/app' },
      async () => [merged],
    ),
    /Cannot verify remote commits.*branches untouched/s,
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('prepare verifies the saved merged branch even when HEAD already returned to main', async (t) => {
  const { repo, vars, merged } = deletedSingleBranch(t);
  git(repo, 'checkout', '-q', 'main');
  const before = git(repo, 'show-ref', '--heads');
  await assertPrepareCommitsPublished(
    vars,
    'next-run',
    bash,
    { githubRepo: 'example/app' },
    async () => [merged],
  );
  assert.equal(git(repo, 'show-ref', '--heads'), before);
});
