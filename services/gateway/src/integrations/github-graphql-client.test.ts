import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';

import { isRecord } from '@farmslot/protocol';

import { rejectMutationRateLimit } from '../../../../scripts/runner-validation/review-provider-fixture.cjs';

import {
  type GitHubFixtureRequest,
  type GitHubFixtureResponse,
  startGitHubFixture,
} from './github-test-fixtures.js';

let route: (
  request: GitHubFixtureRequest,
) => GitHubFixtureResponse | Promise<GitHubFixtureResponse>;
// Validates like GitHub: `rateLimit` is a Query field only.
const fixture = await startGitHubFixture((request) => {
  const body = isRecord(request.json) ? request.json : {};
  const invalid = rejectMutationRateLimit(typeof body.query === 'string' ? body.query : '');
  return invalid ? { body: invalid } : route(request);
});
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;

const { githubGraphQL } = await import('./github-graphql.js');
const { GitHubCursorError } = await import('./github-errors.js');
const { githubQueryBudget } = await import('./github-query-budget.js');

after(async () => {
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
});

const account = { host: 'github.com', token: 'graphql-client-token', scope: 'fixture' };
const sent = (start: number) =>
  fixture.requests.slice(start).map((request) => {
    const body = isRecord(request.json) ? request.json : {};
    return typeof body.query === 'string' ? body.query : '';
  });

describe('githubGraphQL through the client middleware', { concurrency: 1 }, () => {
  beforeEach(() => githubQueryBudget.resetForTests());

  test('queries are metered with rateLimit; mutations are sent as written', async () => {
    route = () => ({ body: { data: { marked: { ok: true } } } });
    const start = fixture.requests.length;
    assert.deepEqual(
      await githubGraphQL<{ marked: { ok: boolean } }>(
        'mutation($id: ID!) { marked: markFileAsViewed(input: { pullRequestId: $id, path: "a" }) { clientMutationId } }',
        { id: 'PR_1' },
        account,
      ),
      { marked: { ok: true } },
    );
    await githubGraphQL('query { viewer { login } }', {}, account);
    const [mutation, query] = sent(start);
    assert.doesNotMatch(mutation ?? '', /rateLimit/);
    assert.match(query ?? '', /rateLimit \{ cost remaining resetAt \} \}$/);
  });

  test('two identical concurrent queries share one request and record the body cost', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    route = async () => {
      await gate;
      return {
        body: { data: { viewer: { login: 'octo' }, rateLimit: { cost: 7, remaining: 4000 } } },
      };
    };
    const start = fixture.requests.length;
    const document = 'query($n: Int!) { viewer { login } }';
    const first = githubGraphQL(document, { n: 1 }, account, 'pr-rules:test');
    const second = githubGraphQL(document, { n: 1 }, account, 'pr-rules:test');
    for (let i = 0; i < 200 && fixture.requests.length === start; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(fixture.requests.length - start, 1);
    const spend = githubQueryBudget.spendSnapshot();
    assert.deepEqual(spend.callers, [{ caller: 'pr-rules:test', cost: 7, queries: 1 }]);
  });

  test('rejections keep their classification and are answered from the negative cache', async () => {
    route = () => ({
      body: { errors: [{ type: 'INVALID_CURSOR_ARGUMENTS', message: 'bad cursor' }] },
    });
    const start = fixture.requests.length;
    const document = 'query($c: String) { viewer { login } }';
    await assert.rejects(githubGraphQL(document, { c: 'x' }, account), GitHubCursorError);
    await assert.rejects(githubGraphQL(document, { c: 'x' }, account), GitHubCursorError);
    assert.equal(fixture.requests.length - start, 1, 'the repeated failure did not reach GitHub');

    route = () => ({ body: {} });
    await assert.rejects(
      githubGraphQL('query($c: String) { empty }', { c: 'y' }, account),
      /GitHub observation incomplete: missing data/,
    );
  });
});
