import { AsyncLocalStorage } from 'node:async_hooks';

import { githubRequestCacheKey, notifyRateLimitHeaders } from './github-client.js';
import {
  GitHubCursorError,
  GitHubPRUnavailableError,
  hasInvalidGitHubCursor,
  hasUnavailableGitHubPR,
} from './github-errors.js';
import { type GhCommandContext, githubRestOp } from './github-operations.js';
import {
  githubQueryBudget as queryBudget,
  GitHubQueryBudgetError,
  resolveGitHubQueryCaller,
} from './github-query-budget.js';

export interface GitHubPage<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
export type GitHubQueryAccount = NonNullable<GhCommandContext['account']>;
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
  _caller?: string,
): Promise<T> {
  const quotaKey = githubRequestCacheKey([], { ...account, scope: 'query-budget' });
  const retryAt = queryBudget.anyReserved();
  if (retryAt) throw new GitHubQueryBudgetError(retryAt);
  const metered = document.replace(/}\s*$/, ' rateLimit { cost remaining resetAt } }');
  const signal = queryDeadlines.getStore();
  type Envelope = {
    data?: T & { rateLimit?: unknown };
    errors?: { type?: string; path?: unknown[]; message?: string }[];
  };
  let result: Envelope;
  let responseHeaders: Map<string, string> | undefined;
  try {
    if (signal?.aborted) throw new Error('Source deadline reached');
    const opResult = await githubRestOp<Envelope>(
      account.host,
      'POST',
      'graphql',
      { body: { query: metered, variables } },
      { account, signal },
    );
    result = opResult.data;
    responseHeaders = opResult.headers;
  } catch (error) {
    // Traversals persist each completed page. Cancellation is an expected partial
    // observation; callers report it and resume, rather than losing the UI request.
    if (signal?.aborted)
      throw new Error(
        'Source scan paused at its time limit; preview again to resume saved progress',
      );
    throw error;
  }
  // Observe quota from HTTP headers first (body rateLimit may be absent in some responses).
  const headers = responseHeaders ?? new Map<string, string>();
  queryBudget.observeHeaders(quotaKey, headers);
  notifyRateLimitHeaders(headers, quotaKey);
  // Observe from body rateLimit when present (more precise cost and remaining).
  queryBudget.observe(quotaKey, result?.data?.rateLimit);
  // Record at least one spend point per query regardless of whether the body has rateLimit.
  queryBudget.record(resolveGitHubQueryCaller(_caller), 1, 1);
  if (hasInvalidGitHubCursor(result?.errors)) throw new GitHubCursorError();
  if (hasUnavailableGitHubPR(result?.errors)) throw new GitHubPRUnavailableError();
  if (result?.errors?.length) {
    throw new Error(`HTTP 200: ${result.errors.map((error) => error.message).join('; ')}`);
  }
  return (result?.data ?? result) as T;
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
