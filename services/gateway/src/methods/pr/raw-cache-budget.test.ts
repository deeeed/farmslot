import assert from 'node:assert/strict';
import { after, afterEach, mock, test } from 'node:test';

import {
  githubQueryBudget,
  GitHubQueryBudgetError,
} from '../../integrations/github-query-budget.js';
import { startGitHubFixture } from '../../integrations/github-test-fixtures.js';

// The batch prefetch runs through the real classified GraphQL exchange; any request it
// sends lands here, never on the network.
const fixture = await startGitHubFixture(() => ({
  body: {
    data: {
      repository: null,
      rateLimit: { cost: 1, remaining: 4000, resetAt: '2099-01-01T00:00:00Z' },
    },
  },
}));
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;
after(async () => {
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
});
/** What the client records once GitHub reports the GraphQL quota exhausted. */
const holdQueryBudget = () =>
  githubQueryBudget.observe('held-credential', {
    remaining: 0,
    cost: 1,
    resetAt: new Date(Date.now() + 120_000).toISOString(),
  });

let paused = false;
let calls = 0;
const clientModule = await import('../../integrations/github-client.js');
const quotaHeld = () => new GitHubQueryBudgetError(new Date(Date.now() + 60000).toISOString());
// Every GraphQL-backed per-PR read is held while paused; plain REST reads still answer.
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
  rest: async () => {
    calls++;
    return [];
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
  holdQueryBudget();
  await assert.rejects(getPRRawData('owner/repo', 1, true), GitHubQueryBudgetError);
  const before = calls;
  assert.deepEqual(await getPRRawData('owner/repo', 1), confirmed);
  assert.equal(calls, before, 'Failed refresh must leave the previous cache entry intact');
  const sent = fixture.requests.length;
  await assert.rejects(
    prefetchPRBatchViaGraphQL(new Map([['owner/repo', [2]]])),
    GitHubQueryBudgetError,
  );
  assert.equal(fixture.requests.length, sent, 'a held budget sends no batch query');
});

test('prefetch does not call GitHub when the query budget is already reserved', async () => {
  holdQueryBudget();
  const before = fixture.requests.length;
  await assert.rejects(
    prefetchPRBatchViaGraphQL(new Map([['owner/repo', [3]]])),
    GitHubQueryBudgetError,
  );
  assert.equal(fixture.requests.length, before, 'reserved budget must not fire GraphQL chunks');
});
