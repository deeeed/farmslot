// github-client.ts — Unified router for every GitHub call the gateway makes.
// Callers keep passing `gh` argument lists; github-gh-command.ts runs them in-process
// over HTTP (no `gh` child per request). Adds X-RateLimit parsing with threshold
// broadcasts, concurrency limiting, in-flight de-duplication, and a 10s negative cache
// for failed requests. Conditional GETs (ETag/304) live in the command layer.
import { createHash } from 'node:crypto';

import { type CommandOutput, Events, type GitHubRateLimitPayload } from '@farmslot/protocol';

import {
  GitHubCursorError,
  GitHubHttpError,
  GitHubPRUnavailableError,
  hasInvalidGitHubCursor,
  hasUnavailableGitHubPR,
} from './github-errors.js';
import { executeGhCommand } from './github-gh-command.js';
import {
  githubQueryBudget,
  GitHubQueryBudgetError,
  resolveGitHubQueryCaller,
} from './github-query-budget.js';

// ─── Types ───

export interface GitHubClientOpts {
  concurrency?: number; // max in-flight GitHub requests (default 8)
  negativeCacheTtlMs?: number; // TTL for failed-call cache (default 10_000)
  warnThresholdPercent?: number; // broadcast when <= N% remaining (default 20)
  critThresholdPercent?: number; // broadcast when <= N% remaining (default 5)
}

export interface GhRequestOpts {
  force?: boolean; // bypass the negative cache and in-flight sharing for this call
  signal?: AbortSignal; // cancel the underlying HTTP request(s)
  /** Explicit account binding. Tokens remain process-local and are never cache keys or log fields. */
  account?: { host: string; token: string; scope: string };
  /** Spend attribution for GraphQL / `gh pr` query-budget reads. */
  caller?: string;
}

interface NegativeCacheEntry {
  error: Error;
  at: number;
}

type QuotaSnapshot = GitHubRateLimitPayload;

// ─── Module state ───

let broadcast: ((event: string, payload: unknown) => void) | null = null;
let maxConcurrency = 8;
let negativeTtlMs = 10_000;
let warnPercent = 20;
let critPercent = 5;

const negativeCache = new Map<string, NegativeCacheEntry>();

interface InFlightEntry {
  promise: Promise<CommandOutput>;
  controller: AbortController;
  refCount: number;
}
const inFlight = new Map<string, InFlightEntry>(); // de-dupe concurrent identical calls

let quota: QuotaSnapshot = {
  remaining: Number.POSITIVE_INFINITY,
  limit: 0,
  resetAt: new Date(0).toISOString(),
  percentUsed: 0,
};
let lastQuotaBucket: 'ok' | 'warn' | 'crit' | null = null;
const quotaObservations = new Map<string, Omit<GitHubRateLimitPayload, 'observations'>>();

// Simple semaphore
let running = 0;
const waitQueue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (running < maxConcurrency) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) =>
    waitQueue.push(() => {
      running++;
      resolve();
    }),
  );
}

function release(): void {
  running--;
  const next = waitQueue.shift();
  if (next) next();
}

// ─── Public API ───

export function initGitHubClient(
  broadcastFn: (event: string, payload: unknown) => void,
  opts?: GitHubClientOpts,
): void {
  broadcast = broadcastFn;
  if (opts?.concurrency != null) maxConcurrency = opts.concurrency;
  if (opts?.negativeCacheTtlMs != null) negativeTtlMs = opts.negativeCacheTtlMs;
  if (opts?.warnThresholdPercent != null) warnPercent = opts.warnThresholdPercent;
  if (opts?.critThresholdPercent != null) critPercent = opts.critThresholdPercent;
  console.log(
    `[github-client] init concurrency=${maxConcurrency} negCacheTtl=${negativeTtlMs}ms warn=${warnPercent}% crit=${critPercent}%`,
  );
}

export function getQuotaSnapshot(): QuotaSnapshot {
  return { ...quota };
}

/**
 * Run a `gh <args>` request in-process with rate-limit observation, query-budget
 * accounting, in-flight sharing and negative caching. GETs revalidate cached ETags,
 * so unchanged data costs a 304 instead of rate limit.
 */
export async function ghRequest(args: string[], opts?: GhRequestOpts): Promise<CommandOutput> {
  const key = githubRequestCacheKey(args, opts?.account);
  const force = opts?.force === true;
  const signal = opts?.signal;
  const canShareInFlight = !force;
  const caller = resolveGitHubQueryCaller(opts?.caller);

  // Negative cache: collapse repeated failures inside the TTL window.
  if (!force) {
    const neg = negativeCache.get(key);
    if (neg && Date.now() - neg.at < negativeTtlMs) throw neg.error;
  }

  if (canShareInFlight) {
    const existing = inFlight.get(key);
    if (existing) return attachSharedAbortSignal(existing, signal);
    const controller = new AbortController();
    const promise = runGh(args, key, controller.signal, opts?.account, caller).finally(() => {
      inFlight.delete(key);
    });
    const entry: InFlightEntry = { promise, controller, refCount: 0 };
    inFlight.set(key, entry);
    return attachSharedAbortSignal(entry, signal);
  }

  // Forced calls bypass the in-flight share map; the signal aborts the request directly.
  return runGh(args, key, signal, opts?.account, caller);
}

export function githubRequestCacheKey(args: string[], account?: GhRequestOpts['account']): string {
  return JSON.stringify([
    account
      ? [
          account.host.toLowerCase(),
          account.scope,
          createHash('sha256').update(account.token).digest('hex'),
        ]
      : 'ambient',
    args,
  ]);
}

// ─── Internals ───

function attachSharedAbortSignal(
  entry: InFlightEntry,
  signal?: AbortSignal,
): Promise<CommandOutput> {
  if (!signal) {
    entry.refCount += 1;
    return entry.promise.finally(() => {
      entry.refCount -= 1;
    });
  }
  if (signal.aborted) {
    // Caller already aborted; do not register interest, do not affect refcount.
    return Promise.reject(new Error('gh request aborted'));
  }
  entry.refCount += 1;
  let aborted = false;
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<CommandOutput>((_, reject) => {
    onAbort = () => {
      aborted = true;
      // Decrement first so the abort-on-zero check sees the post-abort count.
      entry.refCount -= 1;
      if (entry.refCount <= 0 && !entry.controller.signal.aborted) {
        entry.controller.abort();
      }
      reject(new Error('gh request aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([entry.promise, abortPromise]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (!aborted) entry.refCount -= 1;
  });
}

const GH_FLAGS_WITH_VALUES = new Set([
  '-f',
  '-F',
  '-H',
  '-X',
  '--hostname',
  '--jq',
  '--header',
  '--raw-field',
  '--field',
  '--input',
  '--method',
]);

/** GraphQL endpoint or `gh pr` porcelain that GitHub serves over GraphQL. */
export function isGraphQLBudgetArgs(args: string[]): boolean {
  if (args[0] === 'pr' && ['view', 'list', 'checks'].includes(args[1] ?? '')) return true;
  if (args[0] !== 'api') return false;
  const idx = args.indexOf('graphql');
  if (idx <= 0) return false;
  return !GH_FLAGS_WITH_VALUES.has(args[idx - 1] ?? '');
}

function inferredGitHubQueryCaller(args: string[]): string {
  if (args[0] === 'pr' && args[1]) return `gh:pr-${args[1]}`;
  return 'graphql';
}

export function graphqlCostFromBody(body: string): number {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return 0;
  try {
    const parsed = JSON.parse(trimmed) as { data?: { rateLimit?: { cost?: unknown } } };
    const cost = parsed.data?.rateLimit?.cost;
    return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return 0;
  }
}

function recordGraphQLSpend(args: string[], caller: string, cost: number): void {
  if (!isGraphQLBudgetArgs(args)) return;
  githubQueryBudget.record(
    caller === 'graphql' ? inferredGitHubQueryCaller(args) : caller,
    cost,
    1,
  );
}

async function runGh(
  args: string[],
  key: string,
  signal?: AbortSignal,
  account?: GhRequestOpts['account'],
  caller = 'graphql',
): Promise<CommandOutput> {
  await acquire();
  try {
    // Dashboard batches and gh PR reads share one keyring token. Remaining
    // often lands on a hashed account key while later calls use ambient, so
    // fail closed when any tracked GraphQL credential is reserved.
    if (isGraphQLBudgetArgs(args)) {
      const retryAt = githubQueryBudget.anyReserved();
      if (retryAt) throw new GitHubQueryBudgetError(retryAt);
    }
    const quotaKey = githubRequestCacheKey(
      [],
      account ? { ...account, scope: 'query-budget' } : undefined,
    );
    const previousRemaining = githubQueryBudget.peek(quotaKey)?.remaining;
    const result = await executeGhCommand(args, { signal, account });
    if (result.headers) {
      updateQuotaFromHeaders(result.headers, quotaKey);
      githubQueryBudget.observeHeaders(quotaKey, result.headers);
    }

    // Paginated `gh api` and porcelain commands throw on failure. GraphQL still
    // costs at least one point per page.
    if (result.status === undefined) {
      if (isGraphQLBudgetArgs(args))
        recordGraphQLSpend(
          args,
          caller,
          result.graphqlCost || graphqlCostFromBody(result.stdout) || 1,
        );
      return { stdout: result.stdout, stderr: result.stderr };
    }

    const status = result.status;
    const rawBody = result.rawBody ?? '';
    if (!result.failed && status >= 200 && status < 300) {
      const remaining = Number(result.headers?.get('x-ratelimit-remaining'));
      const bodyCost = graphqlCostFromBody(rawBody);
      const delta =
        Number.isFinite(remaining) &&
        previousRemaining !== undefined &&
        previousRemaining > remaining
          ? previousRemaining - remaining
          : 0;
      recordGraphQLSpend(args, caller, bodyCost || delta || (isGraphQLBudgetArgs(args) ? 1 : 0));
      return { stdout: result.stdout, stderr: result.stderr };
    }
    let invalidCursor = false;
    let unavailablePR = false;
    if (isGraphQLBudgetArgs(args) && rawBody.trim().startsWith('{')) {
      try {
        const errors = JSON.parse(rawBody).errors;
        invalidCursor = hasInvalidGitHubCursor(errors);
        unavailablePR = hasUnavailableGitHubPR(errors);
      } catch (error) {
        if (!(error instanceof SyntaxError))
          throw error; /* Non-JSON provider output remains the HTTP failure below. */
      }
    }
    const err = invalidCursor
      ? new GitHubCursorError()
      : unavailablePR
        ? new GitHubPRUnavailableError()
        : new GitHubHttpError(
            status,
            `gh api ${args.slice(1).join(' ')} failed: HTTP ${status} ${rawBody.slice(0, 400)}`,
          );
    cacheNegative(key, err);
    throw err;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    if (!isAbortError(err)) cacheNegative(key, err);
    throw err;
  } finally {
    release();
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR')
  );
}

function cacheNegative(key: string, err: Error): void {
  negativeCache.set(key, { error: err, at: Date.now() });
  // Bound size — prune oldest when >512 entries.
  if (negativeCache.size > 512) {
    const oldest = negativeCache.keys().next().value;
    if (oldest !== undefined) negativeCache.delete(oldest);
  }
}

function updateQuotaFromHeaders(headers: Map<string, string>, credentialKey: string): void {
  const remainingStr = headers.get('x-ratelimit-remaining');
  const limitStr = headers.get('x-ratelimit-limit');
  const resetStr = headers.get('x-ratelimit-reset');
  if (remainingStr == null || limitStr == null) return;

  let remaining = Number(remainingStr);
  const limit = Number(limitStr);
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return;

  const resetEpoch = resetStr ? Number(resetStr) : 0;
  const resetAt =
    Number.isFinite(resetEpoch) && resetEpoch > 0
      ? new Date(resetEpoch * 1000).toISOString()
      : new Date(0).toISOString();
  const resource = headers.get('x-ratelimit-resource');
  const observationKey = `${credentialKey}/${resource ?? 'unknown'}`;
  const previous = quotaObservations.get(observationKey);
  if (previous && Date.parse(previous.resetAt) > Date.parse(resetAt)) return;
  // Concurrent requests may finish out of order. Match the reserve's monotonic accounting within a reset window.
  if (previous?.resetAt === resetAt) remaining = Math.min(previous.remaining, remaining);
  const percentUsed = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
  const changed =
    remaining !== previous?.remaining || limit !== previous?.limit || resetAt !== previous?.resetAt;
  const observation = {
    remaining,
    limit,
    resetAt,
    percentUsed,
    resource,
    observedAt: new Date().toISOString(),
  };
  quotaObservations.set(observationKey, observation);
  if (quotaObservations.size > 100)
    quotaObservations.delete(quotaObservations.keys().next().value!);
  quota = { ...observation, observations: [...quotaObservations.values()] };

  const percentRemaining = (remaining / limit) * 100;
  const bucket: 'ok' | 'warn' | 'crit' =
    percentRemaining <= critPercent ? 'crit' : percentRemaining <= warnPercent ? 'warn' : 'ok';

  if (changed && broadcast) broadcast(Events.GITHUB_RATE_LIMIT, { ...quota });
  if (bucket !== lastQuotaBucket) {
    console.log(
      `[github-client] quota bucket ${lastQuotaBucket} → ${bucket} remaining=${remaining}/${limit} resetAt=${resetAt}`,
    );
    lastQuotaBucket = bucket;
  }
}
