import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';

import {
  type GitHubFixtureRequest,
  type GitHubFixtureResponse,
  startGitHubFixture,
} from '../../integrations/github-test-fixtures.js';

let route: (request: GitHubFixtureRequest) => GitHubFixtureResponse;
const fixture = await startGitHubFixture((request) => route(request));
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;

// The real client, middleware and GraphQL classification; only GitHub is the local fixture.
const { initGitHubClient } = await import('../../integrations/github-client.js');
const { githubQueryBudget, GitHubQueryBudgetError } =
  await import('../../integrations/github-query-budget.js');
const { peekRetainedPRRawData, prefetchPRBatchViaGraphQL, shouldPrefetchPRRawData } =
  await import('./raw-cache.js');

after(async () => {
  initGitHubClient(() => undefined, { concurrency: 8 });
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
});

const openPr = {
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefName: 'feat/a',
  title: 'A',
  statusCheckRollup: { contexts: { nodes: [], pageInfo: { hasNextPage: false } } },
  comments: { nodes: [] },
  commits: { nodes: [] },
  latestOpinionatedReviews: { nodes: [] },
  reviewRequests: { nodes: [] },
};

describe('batch PR prefetch through the classified GraphQL exchange', { concurrency: 1 }, () => {
  beforeEach(() => githubQueryBudget.resetForTests());

  test('partial data with a GraphQL error caches nothing', async () => {
    route = () => ({
      body: {
        data: { repository: { pr_0: { ...openPr, reviewThreads: null } } },
        errors: [
          { path: ['repository', 'pr_0', 'reviewThreads'], message: 'Timeout on reviewThreads' },
        ],
      },
    });
    const seeded = await prefetchPRBatchViaGraphQL(new Map([['org/partial', [1]]]));
    assert.deepEqual([...seeded], []);
    assert.equal(peekRetainedPRRawData('org/partial', 1), undefined);
    assert.equal(shouldPrefetchPRRawData('org/partial', 1), true, 'no snapshot was written');
  });

  test('a chunk that exhausts the quota holds the queued chunk and records its spend', async () => {
    initGitHubClient(() => undefined, { concurrency: 1 });
    const reset = Math.floor(Date.now() / 1000) + 600;
    route = () => ({
      headers: {
        'x-ratelimit-resource': 'graphql',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      },
      body: {
        data: {
          repository: {
            pr_0: { ...openPr, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
          },
          rateLimit: { cost: 3, remaining: 0, resetAt: new Date(reset * 1000).toISOString() },
        },
      },
    });
    const start = fixture.requests.length;
    try {
      await assert.rejects(
        prefetchPRBatchViaGraphQL(
          new Map([
            ['org/first', [1]],
            ['org/second', [2]],
          ]),
        ),
        GitHubQueryBudgetError,
      );
    } finally {
      initGitHubClient(() => undefined, { concurrency: 8 });
    }
    assert.equal(fixture.requests.length - start, 1, 'the queued chunk never reached GitHub');
    assert.deepEqual(githubQueryBudget.spendSnapshot().callers, [
      { caller: 'pr.list:prefetch', cost: 3, queries: 1 },
    ]);
  });
});
