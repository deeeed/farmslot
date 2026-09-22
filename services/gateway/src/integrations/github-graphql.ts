import { AsyncLocalStorage } from 'node:async_hooks';

import { ghRequest, type GhRequestOpts, githubRequestCacheKey } from './github-client.js';
import {
  GitHubCursorError,
  GitHubPRUnavailableError,
  hasInvalidGitHubCursor,
  hasUnavailableGitHubPR,
} from './github-errors.js';
import { githubQueryBudget as queryBudget, GitHubQueryBudgetError } from './github-query-budget.js';

export interface GitHubPage<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
export type GitHubQueryAccount = NonNullable<GhRequestOpts['account']>;
type Variables = Record<string, string | number | null>;
const queryDeadlines = new AsyncLocalStorage<AbortSignal>();

/** Wall-clock GraphQL budget, including queue wait; other RPC work is outside it. */
export function withGitHubQueryDeadline<T>(
  milliseconds: number,
  work: () => Promise<T>,
): Promise<T> {
  return queryDeadlines.run(AbortSignal.timeout(milliseconds), work);
}

export function gitHubQueryDeadlineExpired(): boolean {
  return queryDeadlines.getStore()?.aborted ?? false;
}

export async function githubGraphQL<T>(
  document: string,
  variables: Variables,
  account: GitHubQueryAccount,
  caller?: string,
): Promise<T> {
  const quotaKey = githubRequestCacheKey([], { ...account, scope: 'query-budget' });
  const retryAt = queryBudget.anyReserved();
  if (retryAt) throw new GitHubQueryBudgetError(retryAt);
  const metered = document.replace(/}\s*$/, ' rateLimit { cost remaining resetAt } }');
  const args = ['api', '--hostname', account.host, 'graphql', '-f', `query=${metered}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== null) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  }
  const signal = queryDeadlines.getStore();
  let stdout: string;
  try {
    if (signal?.aborted) throw new Error('Source deadline reached');
    ({ stdout } = await ghRequest(args, { account, caller, signal }));
  } catch (error) {
    // Traversals persist each completed page. Cancellation is an expected partial
    // observation; callers report it and resume, rather than losing the UI request.
    if (signal?.aborted)
      throw new Error(
        'Source scan paused at its time limit; preview again to resume saved progress',
      );
    throw error;
  }
  const result = JSON.parse(stdout) as {
    data?: T & { rateLimit?: unknown };
    errors?: { message: string }[];
  };
  queryBudget.observe(quotaKey, result.data?.rateLimit);
  if (hasInvalidGitHubCursor(result.errors)) throw new GitHubCursorError();
  if (hasUnavailableGitHubPR(result.errors)) throw new GitHubPRUnavailableError();
  if (result.errors?.length || !result.data) {
    throw new Error(
      `GitHub observation incomplete: ${result.errors?.map((error) => error.message).join('; ') ?? 'missing data'}`,
    );
  }
  return result.data;
}

/** Validate every cursor, including nested thread comments; truncated data cannot resolve incidents. */
export async function collectGitHubPages<T>(
  fetch: (cursor: string | null) => Promise<GitHubPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await fetch(cursor);
    if (
      !page ||
      !Array.isArray(page.nodes) ||
      typeof page.pageInfo?.hasNextPage !== 'boolean' ||
      page.nodes.some((node) => !node)
    ) {
      throw new Error('GitHub returned an incomplete connection');
    }
    items.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return items;
    if (!page.pageInfo.endCursor || seen.has(page.pageInfo.endCursor)) {
      throw new Error('GitHub pagination did not advance');
    }
    cursor = page.pageInfo.endCursor;
    seen.add(cursor);
  }
}
