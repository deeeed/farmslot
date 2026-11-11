import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { GitHubRateLimitPayload } from '@farmslot/protocol';

import { startGitHubFixture } from './github-test-fixtures.js';

interface FixtureReply {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}
const responses: FixtureReply[] = [];
const fixture = await startGitHubFixture(() => {
  const response = responses.shift();
  assert(response, 'Unexpected GitHub request');
  return {
    status: response.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...response.headers },
    body: response.body,
  };
});
const calls = () => fixture.requests.length;
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;
const fakeExecFile = Object.assign(
  () => {
    throw new Error('Use the promisified process adapter');
  },
  {
    [promisify.custom]: async (file: string, args: string[]) => {
      assert.equal(file, 'gh');
      assert.deepEqual(args.slice(0, 2), ['auth', 'token'], 'only credential reads may spawn gh');
      return { stdout: 'ambient-fixture-token\n', stderr: '' };
    },
  },
);
mock.module('node:child_process', { namedExports: { execFile: fakeExecFile } });
const { github } = await import('./github-client.js');
const { githubGraphQL } = await import('./github-graphql.js');
const { githubQueryBudget } = await import('./github-query-budget.js');
after(async () => {
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
});

const graphqlHeaders = (remaining: number, reset: number, limit?: number) => ({
  'x-ratelimit-resource': 'graphql',
  'x-ratelimit-remaining': String(remaining),
  'x-ratelimit-reset': String(reset),
  ...(limit ? { 'x-ratelimit-limit': String(limit) } : {}),
});

describe('GitHub HTTP failures', { concurrency: 1 }, () => {
  beforeEach(() => {
    githubQueryBudget.resetForTests();
  });

  test('GraphQL HTTP 200 errors remain failed while their reset headers fence later queries', async () => {
    const before = calls();
    const reset = Math.floor(Date.now() / 1000) + 600;
    responses.push({
      headers: graphqlHeaders(0, reset),
      body: '{"errors":[{"message":"API rate limit exceeded"}]}',
    });
    const account = { host: 'github.com', token: 'test-quota-credential', scope: 'owner' };
    await assert.rejects(
      githubGraphQL('query { viewer { login } }', {}, account),
      /HTTP 200.*rate limit/,
    );
    await assert.rejects(
      githubGraphQL('query { viewer { id } }', {}, account),
      /query budget is reserved/,
    );
    assert.equal(calls() - before, 1, 'A different query must not retry the exhausted credential');
  });

  test('a 304 revalidation still serves the previously cached response', async () => {
    responses.push(
      { headers: { etag: '"fixture"' }, body: '{"value":42}' },
      { status: 304, body: '' },
    );
    const account = { host: 'github.com', token: 'test-etag-credential', scope: 'owner' };
    assert.deepEqual(await github.rest<{ value: number }>('GET', 'repos/owner/repo', { account }), {
      value: 42,
    });
    assert.deepEqual(
      await github.rest<{ value: number }>('GET', 'repos/owner/repo', { account, force: true }),
      { value: 42 },
    );
    assert.equal(fixture.requests.at(-1)?.headers['if-none-match'], '"fixture"');
  });

  test('paginated and non-API failures cannot become successful command outputs', async () => {
    responses.push(
      { status: 403, body: '{"message":"Resource not accessible"}' },
      { status: 502, headers: { 'content-type': 'text/html' }, body: '<html>bad gateway</html>' },
    );
    await assert.rejects(
      github.rest('GET', 'repos/owner/repo/issues', { paginate: true }),
      /failed: gh: Resource not accessible \(HTTP 403\)/,
    );
    await assert.rejects(
      github.prView('owner/repo', 1, ['title']),
      /failed: HTTP 502: 502 Bad Gateway/,
    );
  });

  test('provider cursor rejection retains a structured error through failed HTTP output', async () => {
    const { GitHubCursorError } = await import('./github-errors.js');
    responses.push({
      body: '{"errors":[{"type":"INVALID_CURSOR_ARGUMENTS","message":"The cursor is invalid"}]}',
    });
    await assert.rejects(
      githubGraphQL(
        'query($cursor:String) { viewer { id } }',
        { cursor: 'invalid' },
        { host: 'github.com', token: 'cursor-test-credential', scope: 'owner' },
      ),
      GitHubCursorError,
    );
  });

  test('only structured missing repository or PR errors mean the target is unavailable', async () => {
    const { GitHubPRUnavailableError } = await import('./github-errors.js');
    for (const [index, path] of [
      ['repository'],
      ['repository', 'pullRequest'],
      ['node'],
      ['repository', 'pullRequest', 'labels'],
    ].entries()) {
      responses.push({
        body: JSON.stringify({ errors: [{ type: 'NOT_FOUND', path, message: 'not found' }] }),
      });
      try {
        await githubGraphQL(
          'query { repository { id } }',
          {},
          { host: 'github.com', token: `test-not-found-${index}`, scope: 'owner' },
        );
        assert.fail('Provider errors must fail');
      } catch (error) {
        assert.equal(error instanceof GitHubPRUnavailableError, index < 2);
      }
    }
  });

  test('ambient gh pr view fails closed when another credential is reserved', async () => {
    githubQueryBudget.observe('hashed', {
      remaining: 0,
      cost: 1,
      resetAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const before = calls();
    await assert.rejects(
      github.prView('owner/repo', 99191, ['title'], { force: true }),
      /query budget is reserved/,
    );
    assert.equal(calls(), before, 'ambient porcelain must not reach GitHub');
  });

  test('GraphQL without rateLimit in the body still records at least one point', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    responses.push({
      headers: graphqlHeaders(4000, reset),
      body: '{"data":{"viewer":{"login":"reader"}}}',
    });
    await githubGraphQL(
      'query { viewer { login } }',
      {},
      { host: 'github.com', token: 'test-budget-record', scope: 'owner' },
    );
    assert.equal(githubQueryBudget.spendSnapshot().hourCost, 1);
  });

  test('paginated GraphQL records at least one point per page without a body rateLimit', async () => {
    responses.push(
      { body: '{"data":{"viewer":{"pageInfo":{"hasNextPage":true,"endCursor":"c1"}}}}' },
      { body: '{"data":{"viewer":{"pageInfo":{"hasNextPage":false,"endCursor":"c2"}}}}' },
    );
    const paginateAccount = { host: 'github.com', token: 'test-paginate-record', scope: 'owner' };
    // Two separate calls simulate two pages; each records at least 1 cost point.
    await githubGraphQL('query($endCursor: String) { viewer { login } }', {}, paginateAccount);
    await githubGraphQL(
      'query($endCursor: String) { viewer { login } }',
      { endCursor: 'c1' },
      paginateAccount,
    );
    const snap = githubQueryBudget.spendSnapshot();
    assert.equal(snap.hourCost, 2);
  });

  test('a reserved GraphQL credential fails closed for later GraphQL on another key', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    responses.push({
      headers: graphqlHeaders(0, reset),
      body: '{"errors":[{"message":"API rate limit exceeded"}]}',
    });
    await assert.rejects(
      githubGraphQL(
        'query { viewer { login } }',
        {},
        { host: 'github.com', token: 'cred-a', scope: 'owner' },
      ),
      /rate limit/,
    );
    const before = calls();
    await assert.rejects(
      githubGraphQL(
        'query { viewer { id } }',
        {},
        { host: 'github.com', token: 'cred-b', scope: 'owner' },
      ),
      /query budget is reserved/,
    );
    assert.equal(calls(), before, 'a second credential must not spend after fail-closed reserve');
  });

  test('legacy dashboard GraphQL reads obey the observed reserve without blocking REST', async () => {
    const account = { host: 'github.com', token: 'test-dashboard-reserve', scope: 'owner' };
    const reset = Math.floor(Date.now() / 1000) + 600;
    responses.push({
      headers: graphqlHeaders(12, reset, 5000),
      body: '{"data":{"viewer":{"login":"reader"}}}',
    });
    await githubGraphQL('query { viewer { login } }', {}, account);
    const before = calls();
    await assert.rejects(
      githubGraphQL('query { viewer { login2 } }', {}, account),
      /query budget is reserved/,
    );
    await assert.rejects(
      github.prView('owner/repo', 1, ['title'], { account, force: true }),
      /query budget is reserved/,
    );
    await assert.rejects(
      github.prChecks('owner/repo', 1, ['name'], { account, force: true }),
      /query budget is reserved/,
    );
    await assert.rejects(
      github.prList('owner/repo', {}, { account, force: true }),
      /query budget is reserved/,
    );
    assert.equal(calls(), before, 'Held requests must not reach GitHub');
    responses.push({
      headers: {
        'x-ratelimit-resource': 'core',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4500',
      },
      body: '{}',
    });
    await github.rest('GET', 'repos/owner/repo', { account, force: true });
    assert.equal(calls(), before + 1);
    const { getQuotaSnapshot } = await import('./github-client.js');
    const observations = getQuotaSnapshot().observations!;
    assert(observations.some((item) => item.resource === 'graphql' && item.remaining === 12));
    assert(observations.some((item) => item.resource === 'core' && item.remaining === 4500));
  });

  test('quota broadcasts update counts within a bucket and identify the resource', async () => {
    const { initGitHubClient, getQuotaSnapshot } = await import('./github-client.js');
    const events: Array<{ event: string; payload: unknown }> = [];
    initGitHubClient((event, payload) => events.push({ event, payload }));
    const reset = Math.floor(Date.now() / 1000) + 600;
    for (const remaining of [4000, 3900, 3950]) {
      responses.push({ headers: graphqlHeaders(remaining, reset, 5000), body: '{}' });
      await githubGraphQL(
        `query { value${remaining} }`,
        {},
        { host: 'github.com', token: 'test-quota-counts', scope: 'owner' },
      );
    }
    assert.equal(events.length, 2);
    assert.equal(getQuotaSnapshot().resource, 'graphql');
    assert.equal(
      getQuotaSnapshot().remaining,
      3900,
      'A late older response cannot raise the displayed budget',
    );
    assert.equal((events[1].payload as GitHubRateLimitPayload).remaining, 3900);
    assert(Number.isFinite(Date.parse((events[1].payload as GitHubRateLimitPayload).observedAt!)));
  });
});
