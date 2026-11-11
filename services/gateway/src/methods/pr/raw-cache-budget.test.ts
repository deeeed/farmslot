import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import {
  githubQueryBudget,
  GitHubQueryBudgetError,
} from '../../integrations/github-query-budget.js';

let paused = false;
let calls = 0;
const clientModule = await import('../../integrations/github-client.js');
const quotaHeld = () => new GitHubQueryBudgetError(new Date(Date.now() + 60000).toISOString());
// Every GraphQL-backed read is held while paused; plain REST reads still answer.
const budgetFakeGithub = {
  ...clientModule.github,
  prChecks: async () => {
    calls++;
    if (paused) throw quotaHeld();
    return [{ name: 'unit', bucket: 'pass', startedAt: '', completedAt: '', state: 'SUCCESS' }];
  },
  prView: async () => {
    calls++;
    if (paused) throw quotaHeld();
    return { state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  },
  graphql: async (_doc: string, vars: Record<string, unknown>) => {
    calls++;
    if (paused) throw quotaHeld();
    return 'endCursor' in vars
      ? {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        }
      : { repository: { pullRequest: {} } };
  },
  rest: async (_method: string, path: string) => {
    calls++;
    if (path !== 'graphql') return [];
    if (paused) throw quotaHeld();
    return { data: { repository: null } };
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
