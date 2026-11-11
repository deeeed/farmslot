import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import type { GitHubService } from '../../integrations/github-client.js';
import {
  githubQueryBudget,
  GitHubQueryBudgetError,
} from '../../integrations/github-query-budget.js';

let paused = false;
let calls = 0;
const clientModule = await import('../../integrations/github-client.js');
const budgetFakeGithub: GitHubService = {
  ...clientModule.github,
  graphql: async <T>() => {
    calls++;
    if (paused) throw new GitHubQueryBudgetError(new Date(Date.now() + 60000).toISOString());
    return {
      repository: {
        pr_0: {
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          headRefName: 'main',
        },
      },
    } as unknown as T;
  },
  rest: async <T>() => {
    calls++;
    if (paused) throw new GitHubQueryBudgetError(new Date(Date.now() + 60000).toISOString());
    return { data: { repository: null } } as unknown as T;
  },
};
mock.module('../../integrations/github-client.js', {
  namedExports: { ...clientModule, github: budgetFakeGithub },
});
const { getPRRawData, prefetchPRBatchViaGraphQL } = await import('./raw-cache.js');

afterEach(() => {
  githubQueryBudget.resetForTests();
});

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

test('prefetch does not call GitHub when the query budget is already reserved', async () => {
  githubQueryBudget.observe('other-credential', {
    remaining: 0,
    cost: 1,
    resetAt: new Date(Date.now() + 120_000).toISOString(),
  });
  const before = calls;
  await assert.rejects(
    prefetchPRBatchViaGraphQL(new Map([['owner/repo', [3]]])),
    GitHubQueryBudgetError,
  );
  assert.equal(calls, before, 'reserved budget must not fire GraphQL chunks');
});
