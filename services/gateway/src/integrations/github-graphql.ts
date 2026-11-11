import { AsyncLocalStorage } from 'node:async_hooks';

import {
  githubRequestCacheKey,
  notifyRateLimitHeaders,
  runGitHubGraphQLExchange,
} from './github-client.js';
import {
  GitHubCursorError,
  GitHubPRUnavailableError,
  hasInvalidGitHubCursor,
  hasUnavailableGitHubPR,
} from './github-errors.js';
import { type GhCommandContext, githubRestOp } from './github-operations.js';
import { githubQueryBudget as queryBudget, GitHubQueryBudgetError } from './github-query-budget.js';
import { defaultGitHubHost, graphqlEndpoint } from './github-transport.js';

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

/** GitHub rejects `rateLimit` outside `Query`, so only query documents are metered. */
function meteredDocument(document: string): string {
  if (/^\s*mutation\b/.test(document)) return document;
  return document.replace(/}\s*$/, ' rateLimit { cost remaining resetAt } }');
}

function rateLimitCost(rateLimit: unknown): number {
  const cost =
    rateLimit && typeof rateLimit === 'object' && 'cost' in rateLimit ? rateLimit.cost : 0;
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0;
}

export function githubGraphQL<T>(
  document: string,
  variables: Variables,
  account: GitHubQueryAccount,
  caller?: string,
): Promise<T> {
  return classifiedGraphQL<T>(account.host, account, document, variables, caller);
}

/** The same classified read with the ambient keyring credential on gh's default host. */
export function githubAmbientGraphQL<T>(
  document: string,
  variables: Variables,
  caller?: string,
): Promise<T> {
  return classifiedGraphQL<T>(defaultGitHubHost(), undefined, document, variables, caller);
}

async function classifiedGraphQL<T>(
  host: string,
  account: GitHubQueryAccount | undefined,
  document: string,
  variables: Variables,
  caller: string | undefined,
): Promise<T> {
  const quotaKey = githubRequestCacheKey(
    [],
    account ? { ...account, scope: 'query-budget' } : undefined,
  );
  const retryAt = queryBudget.anyReserved();
  if (retryAt) throw new GitHubQueryBudgetError(retryAt);
  const metered = meteredDocument(document);
  const signal = queryDeadlines.getStore();
  type Envelope = {
    data?: T & { rateLimit?: unknown };
    errors?: { type?: string; path?: unknown[]; message?: string }[];
  };
  try {
    if (signal?.aborted) throw new Error('Source deadline reached');
    // Rejections are classified inside the exchange so the client's negative cache keeps them.
    return await runGitHubGraphQLExchange<T>(
      host,
      metered,
      variables,
      async (ctx) => {
        const { data: result, headers } = await githubRestOp<Envelope | null>(
          host,
          'POST',
          graphqlEndpoint(host),
          { body: { query: metered, variables } },
          ctx,
        );
        queryBudget.observe(quotaKey, result?.data?.rateLimit);
        if (result?.errors?.length || !result?.data) {
          if (headers) {
            queryBudget.observeHeaders(quotaKey, headers);
            notifyRateLimitHeaders(headers, quotaKey);
          }
          if (hasInvalidGitHubCursor(result?.errors)) throw new GitHubCursorError();
          if (hasUnavailableGitHubPR(result?.errors)) throw new GitHubPRUnavailableError();
          if (result?.errors?.length)
            throw new Error(`HTTP 200: ${result.errors.map((error) => error.message).join('; ')}`);
          throw new Error('GitHub observation incomplete: missing data');
        }
        return { data: result.data, headers, graphqlCost: rateLimitCost(result.data.rateLimit) };
      },
      { account, signal, caller },
    );
  } catch (error) {
    // Traversals persist each completed page. Cancellation is an expected partial
    // observation; callers report it and resume, rather than losing the UI request.
    if (signal?.aborted)
      throw new Error(
        'Source scan paused at its time limit; preview again to resume saved progress',
      );
    throw error;
  }
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
