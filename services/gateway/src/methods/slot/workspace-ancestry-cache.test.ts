import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const github = await import('../../integrations/github-client.js');
const comparisons: string[] = [];
let failNext = false;
mock.module('../../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async (args: string[]) => {
      const endpoint = args[1] ?? '';
      comparisons.push(endpoint);
      if (failNext) {
        failNext = false;
        throw new Error('Fixture compare unavailable');
      }
      const base = /\/compare\/([a-f0-9]+)\.\.\./.exec(endpoint)?.[1];
      assert(base, 'The provider read must name the actual base SHA');
      return {
        stdout: JSON.stringify({
          status: 'ahead',
          base_commit: { sha: base },
          merge_base_commit: { sha: base },
        }),
        stderr: '',
      };
    },
  },
});
const { refIncludedInMergedPullRequest } = await import('./unmerged-work.js');
const { bash, git, slotRepo } = await import('./unmerged-work.test-support.js');

test('passive SHA pairs share a compare; changed SHA and command reads still contact the provider', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const head = git(repo, 'rev-parse', 'HEAD');
  const readMerged = async () => [
    { number: 1, baseBranch: 'main', headSha: head, mergeSha: 'b'.repeat(40) },
  ];
  const repository = `fixture/passive-${process.pid}`;
  const before = comparisons.length;
  const options = { allowFetch: false, defaultSha: 'c'.repeat(40) };
  const inspect = (selection = options) =>
    refIncludedInMergedPullRequest(vars, 'HEAD', 'main', repository, bash, readMerged, selection);
  assert.equal(await inspect(), true);
  assert.equal(await inspect(), true);
  assert.equal(comparisons.length, before + 1);
  assert.equal(await inspect({ ...options, defaultSha: 'd'.repeat(40) }), true);
  assert.equal(comparisons.length, before + 2);
  assert.equal(await inspect({ ...options, allowFetch: true }), true);
  assert.equal(await inspect({ ...options, allowFetch: true }), true);
  assert.equal(comparisons.length, before + 4, 'acting reads never use passive ancestry facts');
});

test('an unavailable comparison remains a failure and is not retained as an ancestry fact', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const head = git(repo, 'rev-parse', 'HEAD');
  const readMerged = async () => [
    { number: 1, baseBranch: 'main', headSha: head, mergeSha: 'e'.repeat(40) },
  ];
  const before = comparisons.length;
  const inspect = () =>
    refIncludedInMergedPullRequest(
      vars,
      'HEAD',
      'main',
      `fixture/retry-${process.pid}`,
      bash,
      readMerged,
      { allowFetch: false, defaultSha: 'f'.repeat(40) },
    );
  failNext = true;
  await assert.rejects(inspect(), /Fixture compare unavailable/);
  assert.equal(await inspect(), true);
  assert.equal(comparisons.length, before + 2);
});
