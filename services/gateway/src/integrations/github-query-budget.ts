import { AsyncLocalStorage } from 'node:async_hooks';

import type { GitHubQuerySpendSnapshot } from '@farmslot/protocol';

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

interface SpendEvent {
  at: number;
  caller: string;
  cost: number;
  queries: number;
}

const HOUR_MS = 60 * 60 * 1000;
const MAX_SPEND_EVENTS = 4_000;
const githubQueryCaller = new AsyncLocalStorage<string>();
/** Ambient `gh` credential quota key (`githubRequestCacheKey([], undefined)`). */
export const DEFAULT_QUERY_BUDGET_KEY = '["ambient",[]]';

export function withGitHubQueryCaller<T>(caller: string, run: () => T): T {
  const label = caller.trim();
  return label ? githubQueryCaller.run(label, run) : run();
}

export function resolveGitHubQueryCaller(explicit?: string): string {
  const label = explicit?.trim() || githubQueryCaller.getStore()?.trim();
  return label || 'graphql';
}

/** Shared per-credential budget, independent of the principal-scoped response caches. */
export class GitHubQueryBudget {
  private readonly quotas = new Map<string, GitHubQueryQuota>();
  private spend: SpendEvent[] = [];

  peek(key: string): GitHubQueryQuota | undefined {
    return this.quotas.get(key);
  }

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

  /** True when any tracked GraphQL credential is below the reserve. */
  anyReserved(now = Date.now()): string | undefined {
    let latest: string | undefined;
    for (const key of this.quotas.keys()) {
      const retryAt = this.nextEligibleAt(key, now);
      if (retryAt && (!latest || Date.parse(retryAt) > Date.parse(latest))) latest = retryAt;
    }
    return latest;
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

  record(caller: string, cost: number, queries = 1, now = Date.now()): void {
    const label = resolveGitHubQueryCaller(caller);
    const points = Number.isFinite(cost) && cost > 0 ? Math.round(cost) : 0;
    const count = Number.isFinite(queries) && queries > 0 ? Math.round(queries) : 1;
    this.spend.push({ at: now, caller: label, cost: points, queries: count });
    if (this.spend.length > MAX_SPEND_EVENTS)
      this.spend = this.spend.slice(this.spend.length - MAX_SPEND_EVENTS);
  }

  resetForTests(): void {
    this.quotas.clear();
    this.spend = [];
  }

  spendSnapshot(now = Date.now()): GitHubQuerySpendSnapshot {
    const cutoff = now - HOUR_MS;
    this.spend = this.spend.filter((event) => event.at >= cutoff);
    const byCaller = new Map<string, { cost: number; queries: number }>();
    let hourCost = 0;
    let hourQueries = 0;
    for (const event of this.spend) {
      hourCost += event.cost;
      hourQueries += event.queries;
      const row = byCaller.get(event.caller) ?? { cost: 0, queries: 0 };
      row.cost += event.cost;
      row.queries += event.queries;
      byCaller.set(event.caller, row);
    }
    const callers = [...byCaller.entries()]
      .map(([caller, row]) => ({ caller, cost: row.cost, queries: row.queries }))
      .sort((left, right) => right.cost - left.cost || right.queries - left.queries);
    let remaining: number | null = null;
    let resetAt: string | null = null;
    for (const quota of this.quotas.values()) {
      if (Date.parse(quota.resetAt) <= now) continue;
      if (remaining === null || quota.remaining < remaining) {
        remaining = quota.remaining;
        resetAt = quota.resetAt;
      }
    }
    return { remaining, resetAt, hourCost, hourQueries, callers };
  }
}

export const githubQueryBudget = new GitHubQueryBudget();
