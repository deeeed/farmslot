// Loopback-only GitHub for the recovery matrix. Unknown operations fail closed.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { isRecord } from '@farmslot/protocol/recipe';

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
    method === 'GET' &&
    /^\/repos\/fixture\/recovery\/issues\/(101|102)\/comments$/.test(pathname)
  )
    return [];
  const rest = /^\/repos\/fixture\/recovery\/pulls\/(101|102)(?:\/(files|reviews|commits))?$/.exec(
    pathname,
  );
  if (method === 'GET' && rest) {
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

/** One server per owned recovery stack; the gateway uses its existing fixture-origin contract. */
export async function startRecoveryGithub(holds: () => string) {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      const payload: unknown = raw ? JSON.parse(raw) : {};
      const pathname = new URL(req.url ?? '/', 'http://fixture').pathname;
      appendFileSync(
        path.join(holds(), 'github-http.jsonl'),
        JSON.stringify({ method: req.method, pathname }) + '\n',
      );
      const result = answer(holds(), req.method ?? 'GET', pathname, payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      // A rejected fixture request must fail the caller, never reach real GitHub.
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: (error as Error).message }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Recovery GitHub did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
