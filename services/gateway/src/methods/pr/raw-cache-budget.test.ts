import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { GitHubQueryBudgetError } from '../../integrations/github-query-budget.js';

let paused = false;
let calls = 0;
mock.module('../../integrations/github-client.js', {
  namedExports: {
    ghRequest: async (args: string[]) => {
      calls++;
      if (paused && (args[0] === 'pr' || args.includes('graphql')))
        throw new GitHubQueryBudgetError(new Date(Date.now() + 60000).toISOString());
      return {
        stdout:
          args[0] === 'pr' && args[1] === 'view' ? 'OPEN\tMERGEABLE\tCLEAN' : 'confirmed-data',
        stderr: '',
      };
    },
  },
});
const { getPRRawData, prefetchPRBatchViaGraphQL } = await import('./raw-cache.js');

test('quota-held refresh fails visibly without replacing confirmed PR data', async () => {
  const confirmed = await getPRRawData('owner/repo', 1);
  assert.match(confirmed.prStateStdout, /OPEN/);
  paused = true;
  await assert.rejects(getPRRawData('owner/repo', 1, true), GitHubQueryBudgetError);
  const before = calls;
  assert.deepEqual(await getPRRawData('owner/repo', 1), confirmed);
  assert.equal(calls, before, 'Failed refresh must leave the previous cache entry intact');
  await assert.rejects(
    prefetchPRBatchViaGraphQL(new Map([['owner/repo', [2]]])),
    GitHubQueryBudgetError,
  );
});
