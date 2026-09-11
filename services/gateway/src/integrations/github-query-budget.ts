export class GitHubQueryBudgetError extends Error {
  constructor(readonly retryAt: string) {
    super(`GitHub query budget is reserved; next eligible read at ${retryAt}`);
    this.name = 'GitHubQueryBudgetError';
  }
}

export interface GitHubQueryQuota {
  cost: number;
  remaining: number;
  resetAt: string;
}

/** Shared per-credential budget, independent of the principal-scoped response caches. */
export class GitHubQueryBudget {
  private readonly quotas = new Map<string, GitHubQueryQuota>();

  observeHeaders(key: string, headers: Map<string, string>): void {
    if (headers.get('x-ratelimit-resource') !== 'graphql') return;
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = new Date(Number(headers.get('x-ratelimit-reset')) * 1000);
    if (!Number.isFinite(remaining) || !Number.isFinite(reset.getTime())) return;
    this.observe(key, { remaining, cost: 0, resetAt: reset.toISOString() });
  }

  nextEligibleAt(key: string, now = Date.now()): string | undefined {
    const quota = this.quotas.get(key);
    return quota && Date.parse(quota.resetAt) > now && quota.remaining < 100
      ? quota.resetAt
      : undefined;
  }

  assertAvailable(key: string, now = Date.now()): void {
    const retryAt = this.nextEligibleAt(key, now);
    if (retryAt) throw new GitHubQueryBudgetError(retryAt);
  }

  observe(key: string, value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const quota = value as Partial<GitHubQueryQuota>;
    if (
      typeof quota.remaining !== 'number' ||
      !Number.isFinite(quota.remaining) ||
      typeof quota.cost !== 'number' ||
      !Number.isFinite(quota.cost) ||
      typeof quota.resetAt !== 'string' ||
      !Number.isFinite(Date.parse(quota.resetAt))
    )
      return;
    const previous = this.quotas.get(key);
    const resetAt = new Date(quota.resetAt).toISOString();
    if (previous && Date.parse(previous.resetAt) > Date.parse(quota.resetAt)) return;
    const remaining =
      previous?.resetAt === resetAt
        ? Math.min(previous.remaining, quota.remaining)
        : quota.remaining;
    this.quotas.set(key, { cost: quota.cost, remaining, resetAt });
    if (this.quotas.size > 100) this.quotas.delete(this.quotas.keys().next().value!);
  }
}

export const githubQueryBudget = new GitHubQueryBudget();
