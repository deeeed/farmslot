import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

await import('../../runtime/mock-pty.test-support.js');
const github = await import('../../integrations/github-client.js');
const forceFlags: Array<boolean | undefined> = [];
const endpoints: string[] = [];
let response = '[]';
const request: typeof github.ghRequest = async (args, options) => {
  forceFlags.push(options?.force);
  endpoints.push(args[1] ?? '');
  return { stdout: response, stderr: '' };
};
mock.module('../../integrations/github-client.js', {
  namedExports: { ...github, ghRequest: request },
});
const { readMergedPreparePullRequests } = await import('./unmerged-work.js');

test('status publication reads use the request cache while prepare keeps fresh publication evidence', async () => {
  await readMergedPreparePullRequests('example/app', 'a'.repeat(40), 5000, false);
  await readMergedPreparePullRequests('example/app', 'a'.repeat(40));
  assert.deepEqual(forceFlags, [false, true]);
});

test('deleted-head lookup requires a merged PR for the exact head branch and repository', async () => {
  const headBranch = 'TAT-4300-feat-sec-electron-bot';
  const merged = {
    number: 277,
    state: 'closed',
    merged_at: '2026-10-28T12:00:00Z',
    base: { ref: 'main' },
    head: { sha: 'a'.repeat(40), ref: headBranch, repo: { full_name: 'example/app' } },
    merge_commit_sha: 'b'.repeat(40),
  };
  response = JSON.stringify([
    { ...merged, merged_at: null },
    { ...merged, state: 'open' },
    { ...merged, head: { ...merged.head, ref: 'other-branch' } },
    { ...merged, head: { ...merged.head, repo: { full_name: 'other/app' } } },
    merged,
  ]);
  assert.deepEqual(
    await readMergedPreparePullRequests('example/app', 'a'.repeat(40), 5000, true, headBranch),
    [
      {
        number: 277,
        baseBranch: 'main',
        headSha: merged.head.sha,
        mergeSha: merged.merge_commit_sha,
      },
    ],
  );
  assert.equal(
    endpoints.at(-1),
    `repos/example/app/pulls?state=closed&head=${encodeURIComponent(`example:${headBranch}`)}&per_page=100`,
  );
  assert.equal(forceFlags.at(-1), true, 'prepare must bypass cached PR state');
});
