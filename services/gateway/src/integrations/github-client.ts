// github-client.ts — Unified router for every GitHub call the gateway makes.
// Callers keep passing `gh` argument lists; github-operations.ts runs them in-process
// over HTTP (no `gh` child per request). Adds X-RateLimit parsing with threshold
// broadcasts, concurrency limiting, in-flight de-duplication, and a 10s negative cache
// for failed requests. Conditional GETs (ETag/304) live in the command layer.
import { createHash } from 'node:crypto';

import { Events, type GitHubRateLimitPayload } from '@farmslot/protocol';

import { GitHubHttpError } from './github-errors.js';
import {
  type GhCommandContext,
  githubGraphQLOp,
  type GitHubOpResult,
  githubPrChecksOp,
  githubPrCommentOp,
  githubPrCreateOp,
  githubPrEditOp,
  githubPrListFieldsOp,
  githubPrListOp,
  githubPrReadyOp,
  githubPrViewOp,
  githubRepoViewOp,
  githubRestOp,
  type PRCreateParams,
  type PREditParams,
  type PRListFilters,
  type RestOpOpts,
} from './github-operations.js';
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

// ─── Typed service layer ───

/** Stable operation-name constants for metrics and attribution. */
export const GH_OP_PR_VIEW = 'github.prView';
export const GH_OP_PR_LIST = 'github.prList';
export const GH_OP_PR_CHECKS = 'github.prChecks';
export const GH_OP_PR_CREATE = 'github.prCreate';
export const GH_OP_PR_EDIT = 'github.prEdit';
export const GH_OP_PR_COMMENT = 'github.prComment';
export const GH_OP_PR_READY = 'github.prReady';
export const GH_OP_REPO_VIEW = 'github.repoView';
export const GH_OP_GRAPHQL = 'github.graphql';
export const GH_OP_REST = 'github.rest';

export interface ServiceOpts {
  force?: boolean;
  signal?: AbortSignal;
  account?: GhRequestOpts['account'];
  caller?: string;
}

export interface RestServiceOpts extends ServiceOpts {
  host?: string;
  paginate?: boolean;
  slurp?: boolean;
  perPage?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Return the raw response body string instead of JSON-parsing it (e.g. diff/patch endpoints). */
  raw?: boolean;
}

export interface GraphQLServiceOpts extends ServiceOpts {
  host?: string;
}

export interface GitHubService {
  prView(
    repo: string,
    prNumber: number,
    fields: string[],
    opts?: ServiceOpts,
  ): Promise<Record<string, unknown>>;
  prList(
    repo: string,
    filters: PRListFilters,
    opts?: ServiceOpts,
  ): Promise<Record<string, unknown>[]>;
  prListFields(
    repo: string,
    fields: string[],
    filters: PRListFilters,
    opts?: ServiceOpts,
  ): Promise<Record<string, unknown>[]>;
  prChecks(
    repo: string,
    prNumber: number,
    fields: string[],
    opts?: ServiceOpts,
  ): Promise<Record<string, unknown>[]>;
  prCreate(repo: string, params: PRCreateParams, opts?: ServiceOpts): Promise<string>;
  prEdit(repo: string, prNumber: number, params: PREditParams, opts?: ServiceOpts): Promise<string>;
  prComment(repo: string, prNumber: number, body: string, opts?: ServiceOpts): Promise<string>;
  prReady(repo: string, prNumber: number, opts?: ServiceOpts): Promise<void>;
  repoView(repo: string, opts?: ServiceOpts): Promise<{ nameWithOwner: string }>;
  graphql<T>(
    query: string,
    variables: Record<string, string | number | null>,
    opts?: GraphQLServiceOpts,
  ): Promise<T>;
  rest<T>(method: string, path: string, opts?: RestServiceOpts): Promise<T>;
}

// Re-export param types so callers import only from this module.
export type {
  GhCommandContext,
  GitHubOpResult,
  PRCreateParams,
  PREditParams,
  PRListFilters,
  RestOpOpts,
};

/** In-flight de-duplication for typed operations (read-only ops only). */
interface TypedInFlightEntry {
  promise: Promise<unknown>;
  controller: AbortController;
  refCount: number;
}
const typedInFlight = new Map<string, TypedInFlightEntry>();

function attachTypedSharedSignal<T>(entry: TypedInFlightEntry, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    entry.refCount += 1;
    return (entry.promise as Promise<T>).finally(() => {
      entry.refCount -= 1;
    });
  }
  if (signal.aborted) return Promise.reject(new Error('gh request aborted'));
  entry.refCount += 1;
  let aborted = false;
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<T>((_, reject) => {
    onAbort = () => {
      aborted = true;
      entry.refCount -= 1;
      if (entry.refCount <= 0 && !entry.controller.signal.aborted) entry.controller.abort();
      reject(new Error('gh request aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([entry.promise as Promise<T>, abortPromise]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (!aborted) entry.refCount -= 1;
  });
}

type TypedOpFn<T> = (ctx: GhCommandContext) => Promise<GitHubOpResult<T>>;

/**
 * Middleware for typed ops: semaphore, query-budget guard, in-flight dedup,
 * negative cache, quota observation, and GraphQL spend recording.
 */
async function runTypedOp<T>(
  cacheKey: string,
  opName: string,
  isWrite: boolean,
  fn: TypedOpFn<T>,
  opts?: ServiceOpts,
): Promise<T> {
  const force = opts?.force === true || isWrite;
  const signal = opts?.signal;
  const caller = resolveGitHubQueryCaller(opts?.caller ?? opName);

  if (!force) {
    const neg = negativeCache.get(cacheKey);
    if (neg && Date.now() - neg.at < negativeTtlMs) throw neg.error;

    const existing = typedInFlight.get(cacheKey);
    if (existing) return attachTypedSharedSignal<T>(existing, signal);

    const controller = new AbortController();
    const promise = execTypedOp(
      cacheKey,
      opName,
      fn,
      controller.signal,
      opts?.account,
      caller,
    ).finally(() => {
      typedInFlight.delete(cacheKey);
    });
    const entry: TypedInFlightEntry = { promise, controller, refCount: 0 };
    typedInFlight.set(cacheKey, entry);
    return attachTypedSharedSignal<T>(entry, signal);
  }

  return execTypedOp(cacheKey, opName, fn, signal, opts?.account, caller);
}

const GRAPHQL_OPS = new Set([GH_OP_PR_VIEW, GH_OP_PR_LIST, GH_OP_PR_CHECKS, GH_OP_GRAPHQL]);

async function execTypedOp<T>(
  cacheKey: string,
  opName: string,
  fn: TypedOpFn<T>,
  signal?: AbortSignal,
  account?: GhRequestOpts['account'],
  caller = 'graphql',
): Promise<T> {
  await acquire();
  try {
    const isGql = GRAPHQL_OPS.has(opName);
    if (isGql) {
      const retryAt = githubQueryBudget.anyReserved();
      if (retryAt) throw new GitHubQueryBudgetError(retryAt);
    }
    const quotaKey = githubRequestCacheKey(
      [],
      account ? { ...account, scope: 'query-budget' } : undefined,
    );
    const previousRemaining = githubQueryBudget.peek(quotaKey)?.remaining;
    const ctx: GhCommandContext = { signal, account };
    const result = await fn(ctx);
    if (result.headers) {
      updateQuotaFromHeaders(result.headers, quotaKey);
      githubQueryBudget.observeHeaders(quotaKey, result.headers);
    }
    if (isGql) {
      const cost = result.graphqlCost ?? 0;
      const remaining = Number(result.headers?.get('x-ratelimit-remaining'));
      const delta =
        Number.isFinite(remaining) &&
        previousRemaining !== undefined &&
        previousRemaining > remaining
          ? previousRemaining - remaining
          : 0;
      githubQueryBudget.record(caller, cost || delta || 1, 1);
    }
    return result.data;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    if (err instanceof GitHubHttpError && err.headers) {
      // A 403/429 carries the exhausted quota: fence later queries before rejecting.
      const quotaKey = githubRequestCacheKey(
        [],
        account ? { ...account, scope: 'query-budget' } : undefined,
      );
      updateQuotaFromHeaders(err.headers, quotaKey);
      githubQueryBudget.observeHeaders(quotaKey, err.headers);
    }
    if (!isAbortError(err)) {
      cacheNegative(cacheKey, err);
      err.message = `failed: ${err.message}`;
    }
    throw err;
  } finally {
    release();
  }
}

function typedOpKey(opName: string, params: unknown[], account?: GhRequestOpts['account']): string {
  return JSON.stringify([
    account
      ? [
          account.host.toLowerCase(),
          account.scope,
          createHash('sha256').update(account.token).digest('hex'),
        ]
      : 'ambient',
    opName,
    params,
  ]);
}

function defaultHost(opts?: { host?: string; account?: GhRequestOpts['account'] }): string {
  return opts?.host ?? opts?.account?.host ?? (process.env.GH_HOST?.trim() || 'github.com');
}

/** Default `GitHubService` instance used by all callers in the gateway. */
export const github: GitHubService = {
  prView(repo, prNumber, fields, opts) {
    const key = typedOpKey(GH_OP_PR_VIEW, [repo, prNumber, fields.slice().sort()], opts?.account);
    return runTypedOp(
      key,
      GH_OP_PR_VIEW,
      false,
      (ctx) => githubPrViewOp(repo, prNumber, fields, ctx),
      opts,
    );
  },

  prList(repo, filters, opts) {
    const key = typedOpKey(GH_OP_PR_LIST, [repo, filters], opts?.account);
    return runTypedOp(key, GH_OP_PR_LIST, false, (ctx) => githubPrListOp(repo, filters, ctx), opts);
  },

  prListFields(repo, fields, filters, opts) {
    const key = typedOpKey(GH_OP_PR_LIST, [repo, fields.slice().sort(), filters], opts?.account);
    return runTypedOp(
      key,
      GH_OP_PR_LIST,
      false,
      (ctx) => githubPrListFieldsOp(repo, fields, filters, ctx),
      opts,
    );
  },

  prChecks(repo, prNumber, fields, opts) {
    const key = typedOpKey(GH_OP_PR_CHECKS, [repo, prNumber, fields.slice().sort()], opts?.account);
    return runTypedOp(
      key,
      GH_OP_PR_CHECKS,
      false,
      (ctx) => githubPrChecksOp(repo, prNumber, fields, ctx),
      opts,
    );
  },

  prCreate(repo, params, opts) {
    const key = typedOpKey(
      GH_OP_PR_CREATE,
      [repo, params.head, params.base, params.title],
      opts?.account,
    );
    return runTypedOp(
      key,
      GH_OP_PR_CREATE,
      true,
      (ctx) => githubPrCreateOp(repo, params, ctx),
      opts,
    );
  },

  prEdit(repo, prNumber, params, opts) {
    const key = typedOpKey(GH_OP_PR_EDIT, [repo, prNumber], opts?.account);
    return runTypedOp(
      key,
      GH_OP_PR_EDIT,
      true,
      (ctx) => githubPrEditOp(repo, prNumber, params, ctx),
      opts,
    );
  },

  prComment(repo, prNumber, body, opts) {
    const key = typedOpKey(GH_OP_PR_COMMENT, [repo, prNumber], opts?.account);
    return runTypedOp(
      key,
      GH_OP_PR_COMMENT,
      true,
      (ctx) => githubPrCommentOp(repo, prNumber, body, ctx),
      opts,
    );
  },

  prReady(repo, prNumber, opts) {
    const key = typedOpKey(GH_OP_PR_READY, [repo, prNumber], opts?.account);
    return runTypedOp(
      key,
      GH_OP_PR_READY,
      true,
      (ctx) => githubPrReadyOp(repo, prNumber, ctx),
      opts,
    );
  },

  repoView(repo, opts) {
    const key = typedOpKey(GH_OP_REPO_VIEW, [repo], opts?.account);
    return runTypedOp(key, GH_OP_REPO_VIEW, false, (ctx) => githubRepoViewOp(repo, ctx), opts);
  },

  graphql<T>(
    query: string,
    variables: Record<string, string | number | null>,
    opts?: GraphQLServiceOpts,
  ): Promise<T> {
    const host = defaultHost(opts);
    const key = typedOpKey(GH_OP_GRAPHQL, [host, query, variables], opts?.account);
    return runTypedOp<T>(
      key,
      GH_OP_GRAPHQL,
      false,
      (ctx) => githubGraphQLOp<T>(host, query, variables, ctx),
      opts,
    );
  },

  rest<T>(method: string, path: string, opts?: RestServiceOpts): Promise<T> {
    const host = defaultHost(opts);
    const isWrite = !['GET', 'HEAD'].includes(method.toUpperCase());
    const restOpts: RestOpOpts = {
      paginate: opts?.paginate,
      slurp: opts?.slurp,
      perPage: opts?.perPage,
      headers: opts?.headers,
      body: opts?.body,
      raw: opts?.raw,
    };
    const key = typedOpKey(
      GH_OP_REST,
      [host, method.toUpperCase(), path, isWrite ? Date.now() : restOpts],
      opts?.account,
    );
    return runTypedOp<T>(
      key,
      GH_OP_REST,
      isWrite,
      (ctx) => githubRestOp<T>(host, method, path, restOpts, ctx),
      opts,
    );
  },
};

/**
 * A GraphQL exchange whose envelope the caller classifies inside `exchange` (githubGraphQL),
 * under the same concurrency limit, negative cache, in-flight sharing and spend recording.
 */
export function runGitHubGraphQLExchange<T>(
  host: string,
  document: string,
  variables: Record<string, string | number | null>,
  exchange: (ctx: GhCommandContext) => Promise<GitHubOpResult<T>>,
  opts?: ServiceOpts,
): Promise<T> {
  const key = typedOpKey(GH_OP_GRAPHQL, [host, 'envelope', document, variables], opts?.account);
  return runTypedOp<T>(key, GH_OP_GRAPHQL, false, exchange, opts);
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

/** Lets githubGraphQL observe quota headers on a response it rejects inside its exchange. */
export function notifyRateLimitHeaders(headers: Map<string, string>, credentialKey: string): void {
  updateQuotaFromHeaders(headers, credentialKey);
}
