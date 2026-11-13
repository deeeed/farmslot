import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { startGitHubFixture } from '../../integrations/github-test-fixtures.js';

let openPrs = 0;
// GitHub's open-PR reads: newest first, at most 100 rows per page (REST caps `per_page`).
const fixture = await startGitHubFixture((request) => {
  if (request.path === '/repos/org/app/pulls') {
    const perPage = Math.min(Number(request.query.get('per_page') ?? 30), 100);
    const page = Number(request.query.get('page') ?? 1);
    const start = (page - 1) * perPage;
    const end = Math.min(start + perPage, openPrs);
    const next =
      end < openPrs
        ? {
            link: `<${fixture.origin}/repos/org/app/pulls?per_page=${perPage}&page=${page + 1}>; rel="next"`,
          }
        : undefined;
    return {
      headers: next,
      body: Array.from({ length: end - start }, (_, i) => ({ number: openPrs - start - i })),
    };
  }
  const body = request.json;
  const variables =
    body && typeof body === 'object' && 'variables' in body ? body.variables : undefined;
  const limit =
    variables && typeof variables === 'object' && 'limit' in variables ? variables.limit : 0;
  const cursor =
    variables && typeof variables === 'object' && 'endCursor' in variables
      ? variables.endCursor
      : null;
  if (request.path !== '/graphql' || typeof limit !== 'number' || limit > 100)
    return { status: 422, body: { message: `unexpected request ${request.url}` } };
  const start = typeof cursor === 'string' ? Number(cursor) : 0;
  const end = Math.min(start + limit, openPrs);
  const nodes = Array.from({ length: end - start }, (_, i) => ({ number: openPrs - start - i }));
  return {
    body: {
      data: {
        repository: {
          pullRequests: {
            totalCount: openPrs,
            nodes,
            pageInfo: { hasNextPage: end < openPrs, endCursor: String(end) },
          },
        },
      },
    },
  };
});
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;

const { retentionContext, RUN_RETENTION_DEPS } = await import('./retention.js');
const { makeRun } = await import('./test-fixtures.js');
const { resetGitHubConditionalCacheForTests } =
  await import('../../integrations/github-operations.js');

after(async () => {
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
});

beforeEach(() => resetGitHubConditionalCacheForTests());

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const onPr = (prNumber: number): Run => ({
  ...makeRun({ id: `run-${prNumber}` }),
  prNumber,
  project: 'app',
  ticketOrPr: `PROJ-${prNumber}`,
});
const read = {
  retentionDays: () => 7,
  projectRepo: async () => 'org/app',
  openPrs: RUN_RETENTION_DEPS.openPrs,
};

test('a run on the oldest of 150 open PRs stays open', async () => {
  openPrs = 150;
  const start = fixture.requests.length;
  const { prState } = await retentionContext([onPr(1), onPr(151)], NOW, read);
  assert.equal(prState(onPr(1)), 'open', 'the oldest open PR is on the second page');
  assert.equal(prState(onPr(151)), 'settled');
  assert.equal(fixture.requests.length - start, 2, 'two pages of 100');
});

test('a list that reaches the read limit is treated as unknown', async () => {
  openPrs = 1200;
  const start = fixture.requests.length;
  const numbers = await RUN_RETENTION_DEPS.openPrs('org/app');
  assert.equal(numbers.length, 1000, 'the read stops at its limit');
  assert.equal(fixture.requests.length - start, 10);
  const { prState } = await retentionContext([onPr(5)], NOW, {
    ...read,
    openPrs: async () => numbers,
  });
  assert.equal(prState(onPr(5)), 'unknown');
});
