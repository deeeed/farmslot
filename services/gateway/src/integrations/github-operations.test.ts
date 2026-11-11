import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, mock, test } from 'node:test';
import { promisify } from 'node:util';

import {
  type GitHubFixtureRequest,
  type GitHubFixtureResponse,
  startGitHubFixture,
} from './github-test-fixtures.js';

let route: (
  request: GitHubFixtureRequest,
) => GitHubFixtureResponse | Promise<GitHubFixtureResponse> = () => ({
  status: 500,
  body: { message: 'no route' },
});
const fixture = await startGitHubFixture((request) => route(request));
process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;

const keyring: string[] = [];
const processes: string[][] = [];
const fakeExecFile = Object.assign(
  () => {
    throw new Error('Use the promisified process adapter');
  },
  {
    [promisify.custom]: async (file: string, args: string[]) => {
      processes.push([file, ...args]);
      assert.deepEqual([file, ...args.slice(0, 2)], ['gh', 'auth', 'token']);
      const token = keyring.shift();
      assert(token, 'unexpected keyring read');
      return { stdout: `${token}\n`, stderr: '' };
    },
  },
);
mock.module('node:child_process', { namedExports: { execFile: fakeExecFile } });

const { github } = await import('./github-client.js');
const { GitHubHttpError } = await import('./github-errors.js');
const { ConditionalCache, resetGitHubConditionalCacheForTests } =
  await import('./github-operations.js');
const transport = await import('./github-transport.js');
const { githubQueryBudget } = await import('./github-query-budget.js');

const scratch = await mkdtemp(path.join(os.tmpdir(), 'gh-command-test-'));
after(async () => {
  delete process.env.FARMSLOT_GITHUB_API_URL;
  await fixture.close();
  await rm(scratch, { recursive: true, force: true });
});

const requestsSince = (start: number) => fixture.requests.slice(start);
const authOf = (request: GitHubFixtureRequest) => request.headers.authorization;

describe('in-process gh client', { concurrency: 1 }, () => {
  beforeEach(() => {
    transport.resetGitHubTokensForTests();
    resetGitHubConditionalCacheForTests();
    githubQueryBudget.resetForTests();
    keyring.length = 0;
    processes.length = 0;
  });

  test('concurrent identical requests share one HTTP exchange', async () => {
    keyring.push('dedup-token');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    route = async () => {
      await gate;
      return { body: { login: 'octo' } };
    };
    const start = fixture.requests.length;
    const first = github.rest<{ login: string }>('GET', 'dedup/user');
    const second = github.rest<{ login: string }>('GET', 'dedup/user');
    for (let i = 0; i < 200 && fixture.requests.length === start; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    assert.deepEqual(await Promise.all([first, second]), [{ login: 'octo' }, { login: 'octo' }]);
    assert.equal(requestsSince(start).length, 1);
  });

  test('failures are cached for the negative TTL; force bypasses the cache', async () => {
    keyring.push('negative-token');
    route = () => ({ status: 500, body: { message: 'boom' } });
    const start = fixture.requests.length;
    await assert.rejects(github.rest('GET', 'negative/thing'), GitHubHttpError);
    await assert.rejects(github.rest('GET', 'negative/thing'), GitHubHttpError);
    assert.equal(requestsSince(start).length, 1);
    await assert.rejects(github.rest('GET', 'negative/thing', { force: true }), GitHubHttpError);
    assert.equal(requestsSince(start).length, 2);
  });

  test('paginated GETs revalidate each page by ETag and reuse the cached pages on 304', async () => {
    keyring.push('etag-token');
    const pages: Record<string, unknown[]> = { '1': [{ id: 1 }, { id: 2 }], '2': [{ id: 3 }] };
    route = (request) => {
      const page = request.query.get('page') ?? '1';
      const etag = `"page-${page}"`;
      const link: Record<string, string> =
        page === '1'
          ? {
              link: `<${fixture.origin}/repos/o/r/issues/1/comments?per_page=100&page=2>; rel="next"`,
            }
          : {};
      if (request.headers['if-none-match'] === etag) return { status: 304, headers: link };
      return { headers: { etag, ...link }, body: pages[page] };
    };
    const restPath = 'repos/o/r/issues/1/comments';
    const start = fixture.requests.length;
    const result1 = await github.rest<Array<{ id: number }>>('GET', restPath, {
      paginate: true,
      force: true,
    });
    assert.deepEqual(
      result1.map((r) => r.id),
      [1, 2, 3],
    );
    const result2 = await github.rest<Array<{ id: number }>>('GET', restPath, {
      paginate: true,
      force: true,
    });
    assert.deepEqual(
      result2.map((r) => r.id),
      [1, 2, 3],
    );
    const revalidated = requestsSince(start).slice(2);
    assert.deepEqual(
      revalidated.map((request) => request.headers['if-none-match']),
      ['"page-1"', '"page-2"'],
    );
    assert.equal(revalidated[0].query.get('per_page'), '100');
  });

  test('the conditional cache is bounded by entries and bytes, least recently used first', () => {
    const entry = (bytes: number) => ({ etag: 'e', body: 'b', contentType: '', link: '', bytes });
    const cache = new ConditionalCache(2, 100);
    cache.set('a', entry(10));
    cache.set('b', entry(10));
    assert(cache.get('a'));
    cache.set('a', entry(10));
    cache.set('c', entry(10));
    assert.equal(cache.get('b'), undefined, 'least recently used entry is evicted');
    assert(cache.get('a') && cache.get('c'));
    cache.set('d', entry(20));
    cache.set('e', entry(20));
    assert.equal(cache.get('a'), undefined);
    cache.set('huge', entry(26));
    assert.equal(
      cache.get('huge'),
      undefined,
      'bodies over a quarter of the budget are not cached',
    );
    const bytesBound = new ConditionalCache(10, 50);
    for (const key of ['p', 'q', 'r']) bytesBound.set(key, entry(12));
    bytesBound.set('s', entry(12));
    bytesBound.set('t', entry(12));
    assert.equal(bytesBound.get('p'), undefined, 'byte budget evicts the oldest entry');
    assert(bytesBound.get('t'));
  });

  test('a rejected keyring token is re-read once and the request retried', async (t) => {
    keyring.push('stale-token', 'fresh-token');
    route = (request) =>
      authOf(request) === 'token fresh-token'
        ? { body: { ok: true } }
        : { status: 401, body: { message: 'Bad credentials' } };
    const start = fixture.requests.length;
    // These tests exercise keyring + retry behavior: unset the override so the transport
    // reads the keyring, then redirect fetch to the fixture server.
    const origin = fixture.origin;
    const realFetch = globalThis.fetch;
    t.mock.method(
      globalThis as { fetch: typeof globalThis.fetch },
      'fetch',
      (url: string | URL, init?: RequestInit): Promise<Response> => {
        const u = new URL(String(url));
        return realFetch(origin + u.pathname + u.search, init);
      },
    );
    delete process.env.FARMSLOT_GITHUB_API_URL;
    try {
      assert.deepEqual(await github.rest<{ ok: boolean }>('GET', 'refresh/one'), { ok: true });
      assert.deepEqual(await github.rest<{ ok: boolean }>('GET', 'refresh/two'), { ok: true });
      assert.deepEqual(requestsSince(start).map(authOf), [
        'token stale-token',
        'token fresh-token',
        'token fresh-token',
      ]);
      assert.equal(processes.length, 2, 'the fresh token is cached after the retry');
    } finally {
      process.env.FARMSLOT_GITHUB_API_URL = origin;
    }
  });

  test('an explicit account is not retried on 401 and its cached token is dropped', async (t) => {
    keyring.push('account-token', 'account-token-2');
    const origin = fixture.origin;
    const realFetch = globalThis.fetch;
    t.mock.method(
      globalThis as { fetch: typeof globalThis.fetch },
      'fetch',
      (url: string | URL, init?: RequestInit): Promise<Response> => {
        const u = new URL(String(url));
        return realFetch(origin + u.pathname + u.search, init);
      },
    );
    delete process.env.FARMSLOT_GITHUB_API_URL;
    try {
      const token = await transport.resolveGitHubToken('github.com', 'reviewer');
      route = () => ({ status: 401, body: { message: 'Bad credentials' } });
      const start = fixture.requests.length;
      await assert.rejects(
        github.rest('GET', 'account/user', { account: { host: 'github.com', token, scope: 's' } }),
        (error: unknown) => error instanceof GitHubHttpError && error.status === 401,
      );
      assert.equal(requestsSince(start).length, 1);
      assert.equal(await transport.resolveGitHubToken('github.com', 'reviewer'), 'account-token-2');
    } finally {
      process.env.FARMSLOT_GITHUB_API_URL = origin;
    }
  });

  test('aborted requests reject as AbortError and are not failure-cached', async () => {
    keyring.push('abort-token');
    let release!: () => void;
    route = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { body: { late: true } };
    };
    const controller = new AbortController();
    const start = fixture.requests.length;
    const pending = github.rest('GET', 'abort/thing', { signal: controller.signal });
    for (let i = 0; i < 200 && fixture.requests.length === start; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(pending, /aborted/);
    release();
    route = () => ({ body: { fresh: true } });
    assert.deepEqual(await github.rest<{ fresh: boolean }>('GET', 'abort/thing'), { fresh: true });
  });

  test('pr create, edit, comment and ready map to the same GitHub writes', async () => {
    keyring.push('write-token');
    const bodyFile = path.join(scratch, 'body.md');
    await writeFile(bodyFile, 'Body from file');
    const html = 'https://github.com/o/r/pull/7';
    let draft = true;
    route = (request) => {
      if (request.method === 'POST' && request.path === '/repos/o/r/pulls')
        return { status: 201, body: { number: 7, html_url: html } };
      if (request.method === 'PATCH' && request.path === '/repos/o/r/pulls/7')
        return { body: { html_url: html } };
      if (request.method === 'POST' && request.path === '/repos/o/r/issues/7/comments')
        return { status: 201, body: { html_url: `${html}#issuecomment-1` } };
      if (request.method === 'GET' && request.path === '/repos/o/r/pulls/7')
        return { body: { state: 'open', draft, node_id: 'PR_node7' } };
      if (request.path === '/graphql')
        return { body: { data: { markPullRequestReadyForReview: {} } } };
      return { status: 404, body: { message: 'Not Found' } };
    };
    const start = fixture.requests.length;
    const body = await readFile(bodyFile, 'utf-8');
    const created = await github.prCreate(
      'o/r',
      { head: 'feat', base: 'main', title: 'T', body, draft: true },
      { force: true },
    );
    assert.equal(created, `${html}\n`);
    await github.prEdit('o/r', 7, { title: 'New' }, { force: true });
    await github.prComment('o/r', 7, 'hi', { force: true });
    await github.prReady('o/r', 7, { force: true });
    draft = false;
    await github.prReady('o/r', 7, { force: true });
    const writes = requestsSince(start).map((request) => [
      request.method,
      request.path,
      request.json,
    ]);
    assert.deepEqual(writes, [
      [
        'POST',
        '/repos/o/r/pulls',
        { title: 'T', head: 'feat', base: 'main', body: 'Body from file', draft: true },
      ],
      ['PATCH', '/repos/o/r/pulls/7', { title: 'New' }],
      ['POST', '/repos/o/r/issues/7/comments', { body: 'hi' }],
      ['GET', '/repos/o/r/pulls/7', undefined],
      [
        'POST',
        '/graphql',
        {
          query:
            'mutation PullRequestReadyForReview($id: ID!) {markPullRequestReadyForReview(input: {pullRequestId: $id}) {clientMutationId}}',
          variables: { id: 'PR_node7' },
        },
      ],
      ['GET', '/repos/o/r/pulls/7', undefined],
    ]);
  });

  test('repo view resolves an origin URL to the canonical nameWithOwner', async () => {
    keyring.push('repo-token');
    route = (request) =>
      request.path === '/repos/Owner/Repo'
        ? { body: { full_name: 'owner/repo' } }
        : { status: 404, body: {} };
    const result = await github.repoView('git@github.com:Owner/Repo.git', { force: true });
    assert.deepEqual(result, { nameWithOwner: 'owner/repo' });
  });

  test('a PR status refresh spawns one keyring read and no gh request processes', async (t) => {
    keyring.push('refresh-token');
    const origin = fixture.origin;
    const realFetch = globalThis.fetch;
    route = (request) => {
      if (request.path === '/graphql') {
        const query = String((request.json as { query?: string }).query);
        if (query.includes('PullRequestStatusChecks'))
          return {
            body: {
              data: {
                repository: {
                  pullRequest: {
                    headRefName: 'feat',
                    statusCheckRollup: {
                      nodes: [
                        {
                          commit: {
                            statusCheckRollup: {
                              contexts: {
                                nodes: [
                                  {
                                    __typename: 'CheckRun',
                                    name: 'ci',
                                    status: 'COMPLETED',
                                    conclusion: 'SUCCESS',
                                  },
                                ],
                                pageInfo: { hasNextPage: false },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          };
        return { body: { data: { repository: { pullRequest: { state: 'OPEN', author: null } } } } };
      }
      return { headers: { etag: `"${request.path}"` }, body: [] };
    };
    t.mock.method(
      globalThis as { fetch: typeof globalThis.fetch },
      'fetch',
      (url: string | URL, init?: RequestInit): Promise<Response> => {
        const u = new URL(String(url));
        return realFetch(origin + u.pathname + u.search, init);
      },
    );
    delete process.env.FARMSLOT_GITHUB_API_URL;
    try {
      const refresh = () =>
        Promise.all([
          github.prChecks('o/r', 1, ['name', 'bucket'], { force: true }),
          github.prView('o/r', 1, ['state', 'author'], { force: true }),
          github.rest<unknown[]>('GET', 'repos/o/r/issues/1/comments', {
            paginate: true,
            force: true,
          }),
          github.rest<unknown>('GET', 'repos/o/r/pulls/1/commits', { force: true }),
        ]);
      for (let i = 0; i < 5; i++) await refresh();
      assert.deepEqual(processes, [['gh', 'auth', 'token', '--hostname', 'github.com']]);
    } finally {
      process.env.FARMSLOT_GITHUB_API_URL = origin;
    }
  });

  test('fixture-token rule: override set, no fixture token, keyring is never read', async () => {
    delete process.env.FARMSLOT_GITHUB_FIXTURE_TOKEN;
    keyring.push('should-never-be-read');
    const start = fixture.requests.length;
    route = (request) => ({ body: { noAuth: authOf(request) == null } });
    const result = await github.rest<{ noAuth: boolean }>('GET', 'fixture/rule');
    assert.deepEqual(result, { noAuth: true });
    assert.equal(processes.length, 0, 'keyring was never called');
    assert.equal(fixture.requests.length - start, 1);
  });

  test('prView export maps scalar fields and author through the pr export shape', async () => {
    keyring.push('view-export-token');
    route = (request) => {
      if (request.path === '/graphql') {
        return {
          body: {
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_01',
                  state: 'OPEN',
                  headRefName: 'feat/export',
                  author: { id: 'U_01', login: 'octo', name: 'Octo Cat' },
                },
              },
              rateLimit: { cost: 1 },
            },
          },
        };
      }
      return { body: [] };
    };
    const pr = await github.prView('o/r', 1, ['state', 'headRefName', 'author']);
    assert.deepEqual(pr, {
      state: 'OPEN',
      headRefName: 'feat/export',
      author: { is_bot: false, login: 'octo', id: 'U_01', name: 'Octo Cat' },
    });
  });

  test('prChecks maps GitHub states to buckets and deduplicates check runs', async () => {
    keyring.push('checks-bucket-token');
    route = (request) => {
      if (request.path === '/graphql') {
        return {
          body: {
            data: {
              repository: {
                pullRequest: {
                  headRefName: 'feat',
                  statusCheckRollup: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            contexts: {
                              nodes: [
                                {
                                  __typename: 'CheckRun',
                                  name: 'ci',
                                  status: 'COMPLETED',
                                  conclusion: 'SUCCESS',
                                  startedAt: '2024-01-01T10:00:00Z',
                                  completedAt: null,
                                  detailsUrl: null,
                                  url: null,
                                  checkSuite: {
                                    workflowRun: { event: 'push', workflow: { name: 'CI' } },
                                  },
                                },
                                {
                                  // duplicate of ci — same name/workflow/event, started earlier → deduped
                                  __typename: 'CheckRun',
                                  name: 'ci',
                                  status: 'COMPLETED',
                                  conclusion: 'FAILURE',
                                  startedAt: '2024-01-01T09:00:00Z',
                                  completedAt: null,
                                  detailsUrl: null,
                                  url: null,
                                  checkSuite: {
                                    workflowRun: { event: 'push', workflow: { name: 'CI' } },
                                  },
                                },
                                {
                                  __typename: 'CheckRun',
                                  name: 'lint',
                                  status: 'COMPLETED',
                                  conclusion: 'FAILURE',
                                  startedAt: '2024-01-01T10:00:00Z',
                                  completedAt: null,
                                  detailsUrl: null,
                                  url: null,
                                  checkSuite: {
                                    workflowRun: { event: 'push', workflow: { name: 'Lint' } },
                                  },
                                },
                                {
                                  __typename: 'CheckRun',
                                  name: 'docs',
                                  status: 'COMPLETED',
                                  conclusion: 'SKIPPED',
                                  startedAt: '2024-01-01T10:00:00Z',
                                  completedAt: null,
                                  detailsUrl: null,
                                  url: null,
                                  checkSuite: {
                                    workflowRun: { event: 'push', workflow: { name: 'Docs' } },
                                  },
                                },
                              ],
                              pageInfo: { hasNextPage: false },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
              rateLimit: { cost: 1 },
            },
          },
        };
      }
      return { body: [] };
    };
    const checks = await github.prChecks('o/r', 1, ['name', 'bucket']);
    assert.equal(checks.length, 3, 'duplicate ci run (same name/workflow/event) is deduped');
    const byName = Object.fromEntries(checks.map((c) => [String(c.name), String(c.bucket)]));
    assert.equal(byName['ci'], 'pass', 'SUCCESS conclusion maps to pass');
    assert.equal(byName['lint'], 'fail', 'FAILURE conclusion maps to fail');
    assert.equal(byName['docs'], 'skipping', 'SKIPPED conclusion maps to skipping');
  });

  test('hosts map to github.com, tenancy and Enterprise Server endpoints', () => {
    const saved = process.env.FARMSLOT_GITHUB_API_URL;
    delete process.env.FARMSLOT_GITHUB_API_URL;
    try {
      assert.equal(transport.restPrefix('github.com'), 'https://api.github.com/');
      assert.equal(transport.graphqlEndpoint('github.com'), 'https://api.github.com/graphql');
      assert.equal(transport.restPrefix('acme.ghe.com'), 'https://api.acme.ghe.com/');
      assert.equal(transport.restPrefix('git.example.com'), 'https://git.example.com/api/v3/');
      assert.equal(
        transport.graphqlEndpoint('git.example.com'),
        'https://git.example.com/api/graphql',
      );
    } finally {
      process.env.FARMSLOT_GITHUB_API_URL = saved;
    }
  });
});
