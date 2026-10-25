// Opt-in real-Git publication proof; excluded from the default suite.
import assert from 'node:assert/strict';
import test from 'node:test';

import { type MergedPreparePullRequest, refIncludedInMergedPullRequest } from './unmerged-work.js';
import { bash, commit, git, slotRepo, squashAndPrune } from './unmerged-work.test-support.js';

test('read-only publication accepts an earlier slot head covered by a later squash-merged PR', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const earlier = git(repo, 'rev-parse', 'HEAD');
  commit(repo, 'later-fix.txt');
  const merged = squashAndPrune(repo);
  git(repo, 'reset', '--hard', earlier);
  const beforeRefs = git(repo, 'show-ref');
  assert.equal(
    await refIncludedInMergedPullRequest(
      vars,
      'HEAD',
      'main',
      'example/app',
      bash,
      async () => [merged],
      { allowFetch: false, timeoutMs: 5000 },
    ),
    true,
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), earlier);
  assert.equal(git(repo, 'show-ref'), beforeRefs);
});

test('read-only publication can verify a recent merged default without fetching it into the slot', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const head = git(repo, 'rev-parse', 'HEAD');
  const beforeRefs = git(repo, 'show-ref');
  const mergeSha = '1'.repeat(40),
    remoteDefault = '2'.repeat(40);
  const compared: Array<{ base: string; head: string }> = [];
  const readAncestry = async (_repo: string, base: string, tip: string) => {
    compared.push({ base, head: tip });
    return base === mergeSha && tip === remoteDefault;
  };
  const merged: MergedPreparePullRequest = {
    number: 242,
    baseBranch: 'main',
    headSha: head,
    mergeSha,
  };
  assert.equal(
    await refIncludedInMergedPullRequest(
      vars,
      'HEAD',
      'main',
      'example/app',
      bash,
      async () => [merged],
      { allowFetch: false, timeoutMs: 5000, defaultSha: remoteDefault, readAncestry },
    ),
    true,
  );
  assert.deepEqual(compared, [{ base: mergeSha, head: remoteDefault }]);
  assert.equal(git(repo, 'show-ref'), beforeRefs);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});
