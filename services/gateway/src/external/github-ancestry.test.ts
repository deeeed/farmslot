import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import * as client from '../integrations/github-client.js';

const requests: string[][] = [];
let status = 'ahead';
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...client,
    ghRequest: async (args: string[]) => {
      requests.push(args);
      if (status === 'missing') throw new Error('HTTP 404: No commit found');
      return { stdout: `${status}\n`, stderr: '', exitCode: 0 };
    },
  },
});
const { isGitHubAncestor } = await import('./github.js');

const prior = '5f85b47bfa4f7d8ec1888605f0cd2f025fffb804';
const current = 'da6b612ef57bc81a6c14bc873810b66ee0720eb0';

test('only an ahead or identical comparison proves the prior head is an ancestor', async () => {
  for (const [value, expected] of [
    ['ahead', true],
    ['identical', true],
    ['diverged', false],
    ['behind', false],
  ] as const) {
    status = value;
    assert.equal(await isGitHubAncestor('owner/repo', prior, current), expected, value);
  }
  assert.deepEqual(requests[0], [
    'api',
    `repos/owner/repo/compare/${prior}...${current}`,
    '--jq',
    '.status',
  ]);
});

test('a failed comparison reaches the caller', async () => {
  status = 'missing';
  await assert.rejects(isGitHubAncestor('owner/repo', prior, current), /HTTP 404/);
  await assert.rejects(isGitHubAncestor('owner/repo;rm', prior, current), /Invalid repo/);
  await assert.rejects(isGitHubAncestor('owner/repo', 'main', current), /concrete commit/);
});
