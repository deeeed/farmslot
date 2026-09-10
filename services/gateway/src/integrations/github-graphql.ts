import { ghRequest, type GhRequestOpts, githubRequestCacheKey } from './github-client.js';
import {
  GitHubCursorError,
  GitHubPRUnavailableError,
  hasInvalidGitHubCursor,
  hasUnavailableGitHubPR,
} from './github-errors.js';
import { githubQueryBudget as queryBudget } from './github-query-budget.js';

export interface GitHubPage<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
export type GitHubQueryAccount = NonNullable<GhRequestOpts['account']>;
type Variables = Record<string, string | number | null>;

export async function githubGraphQL<T>(
  document: string,
  variables: Variables,
  account: GitHubQueryAccount,
): Promise<T> {
  const quotaKey = githubRequestCacheKey([], { ...account, scope: 'query-budget' });
  queryBudget.assertAvailable(quotaKey);
  const metered = document.replace(/}\s*$/, ' rateLimit { cost remaining resetAt } }');
  const args = ['api', '--hostname', account.host, 'graphql', '-f', `query=${metered}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== null) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  }
  const { stdout } = await ghRequest(args, { account });
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
