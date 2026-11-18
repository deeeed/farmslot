// Loopback-only GitHub for the recovery matrix. Unknown operations fail closed.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

import { isRecord } from '@farmslot/protocol/recipe';

import { startGitHubFixture } from '../../../services/gateway/src/integrations/github-test-fixtures.js';

const DATE = '2026-11-05T00:00:00Z';

function pullRequest(holds: string, number: number) {
  if (number !== 101 && number !== 102) throw new Error('Unknown recovery PR');
  const repo = path.join(
    path.dirname(holds),
    'slots',
    number === 102 ? 'recovery-fixer-scope-1' : 'recovery-node-timeout-1',
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  return {
    id: `recovery-pr-${number}`,
    number,
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: git('branch', '--show-current'),
    headRefOid: git('rev-parse', 'HEAD'),
    baseRefName: 'main',
    baseRefOid: git('rev-parse', 'origin/main'),
    url: `https://github.com/fixture/recovery/pull/${number}`,
    title: 'Recovery fixture',
    body: 'Fixture',
    createdAt: DATE,
    updatedAt: DATE,
  };
}

function answer(holds: string, method: string, pathname: string, payload: unknown): unknown {
  if (
    method === 'POST' &&
    /^\/repos\/fixture\/recovery\/issues\/(101|102)\/comments$/.test(pathname)
  )
    return { html_url: 'https://fixture.invalid/recovery-comment' };
  if (method === 'POST' && /^\/repos\/fixture\/recovery\/pulls\/(101|102)\/reviews$/.test(pathname))
    return {};
  if (method === 'GET' && pathname.startsWith('/repos/fixture/recovery/compare/'))
    return { files: [], commits: [] };
  if (
    method === 'GET' &&
    /^\/repos\/fixture\/recovery\/issues\/(101|102)\/comments$/.test(pathname)
  )
    return [];
  const rest = /^\/repos\/fixture\/recovery\/pulls\/(101|102)(?:\/(files|reviews|commits))?$/.exec(
    pathname,
  );
  if (rest && (method === 'GET' || (method === 'PATCH' && !rest[2]))) {
    const pr = pullRequest(holds, Number(rest[1]));
    if (rest[2] === 'files' || rest[2] === 'reviews') return [];
    if (rest[2] === 'commits')
      return [{ sha: pr.headRefOid, commit: { committer: { date: DATE } } }];
    return {
      number: pr.number,
      state: 'open',
      title: pr.title,
      body: pr.body,
      html_url: pr.url,
      merged: false,
      merged_at: null,
      head: {
        ref: pr.headRefName,
        sha: pr.headRefOid,
        repo: { full_name: 'fixture/recovery' },
      },
      base: { ref: pr.baseRefName, sha: pr.baseRefOid },
    };
  }
  if (pathname === '/graphql' && method === 'POST' && isRecord(payload)) {
    const variables = payload.variables;
    // Branch-scoped PR lookup: discovery's own open PR, and the merged-PR probe
    // finalize runs before offering Close as Shipped. Both are PullRequestList
    // in production (github-operations.ts), so the fixture answers the same
    // query rather than a REST stand-in. The fixture's PRs are open and nothing
    // merges out of band here, so a MERGED/CLOSED state filter is empty.
    if (
      typeof payload.query === 'string' &&
      /query PullRequestList\(/.test(payload.query) &&
      isRecord(variables) &&
      variables.owner === 'fixture' &&
      (variables.repo ?? variables.name) === 'recovery'
    ) {
      const states = Array.isArray(variables.state)
        ? variables.state.filter((state): state is string => typeof state === 'string')
        : ['OPEN'];
      const head = typeof variables.headBranch === 'string' ? variables.headBranch : undefined;
      const base = typeof variables.baseBranch === 'string' ? variables.baseBranch : undefined;
      const nodes = states.includes('OPEN')
        ? [101, 102]
            .map((number) => pullRequest(holds, number))
            .filter((pr) => head === undefined || pr.headRefName === head)
            .filter((pr) => base === undefined || pr.baseRefName === base)
            .map((pr) => ({ ...pr, author: { login: 'fixture' } }))
        : [];
      return {
        data: {
          repository: {
            pullRequests: {
              totalCount: nodes.length,
              nodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          rateLimit: { cost: 1 },
        },
      };
    }
    const reviewQuery =
      typeof payload.query === 'string' &&
      (payload.query.includes('reviewThreads(first:') ||
        payload.query.includes('latestOpinionatedReviews(first:'));
    if (
      typeof payload.query === 'string' &&
      (/query PullRequest(ByNumber|StatusChecks)\(/.test(payload.query) || reviewQuery) &&
      isRecord(variables) &&
      variables.owner === 'fixture' &&
      (variables.repo ?? variables.name) === 'recovery' &&
      typeof (variables.pr_number ?? variables.pr) === 'number'
    ) {
      const number = variables.pr_number ?? variables.pr;
      if (typeof number !== 'number') throw new Error('Recovery PR number is required');
      const pr = pullRequest(holds, number);
      const emptyPage = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      return {
        data: {
          repository: {
            pullRequest: {
              ...pr,
              author: { login: 'fixture' },
              reviewThreads: emptyPage,
              latestOpinionatedReviews: emptyPage,
              reviewRequests: emptyPage,
              statusCheckRollup: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              name: 'fixture',
                              status: pr.number === 102 ? 'COMPLETED' : 'IN_PROGRESS',
                              conclusion: pr.number === 102 ? 'FAILURE' : null,
                              startedAt: DATE,
                              completedAt: pr.number === 102 ? DATE : null,
                              detailsUrl: 'https://fixture.invalid/check',
                            },
                          ],
                          pageInfo: { hasNextPage: false, endCursor: null },
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
      };
    }
  }
  throw new Error(`Unsupported recovery GitHub operation: ${method} ${pathname}`);
}

/** One server per owned recovery stack, using the shared GitHub fixture transport. */
export function startRecoveryGithub(holds: () => string) {
  // Async keeps handler failures on the shared transport's rejected-response path.
  return startGitHubFixture(async ({ method, path: pathname, json }) => {
    appendFileSync(
      path.join(holds(), 'github-http.jsonl'),
      JSON.stringify({ method, pathname }) + '\n',
    );
    return { body: answer(holds(), method, pathname, json) };
  });
}
