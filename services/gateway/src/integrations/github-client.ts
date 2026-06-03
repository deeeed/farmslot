// github-client.ts — Unified router for all `gh` CLI calls.
// Adds ETag/If-None-Match caching, X-RateLimit parsing with threshold broadcasts,
// concurrency limiting, and a 10s negative cache for failed requests.
// Long-term replacement for per-caller ghExec/ghExecCached (roadmap F2.8).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type CommandOutput, Events } from '@farmslot/protocol';

const execFileAsync = promisify(execFile);

// ─── Types ───

export interface GitHubClientOpts {
  concurrency?: number; // max in-flight gh calls (default 8)
  negativeCacheTtlMs?: number; // TTL for failed-call cache (default 10_000)
  warnThresholdPercent?: number; // broadcast when <= N% remaining (default 20)
  critThresholdPercent?: number; // broadcast when <= N% remaining (default 5)
}

export interface GhRequestOpts {
  force?: boolean; // bypass ETag + negative cache for this call
  signal?: AbortSignal; // cancel the underlying gh child process
}

interface CacheEntry {
  etag: string;
  body: string; // successful body (HTTP 200)
  at: number;
}

interface NegativeCacheEntry {
  error: Error;
  at: number;
}

interface QuotaSnapshot {
  remaining: number;
  limit: number;
  resetAt: string; // ISO-8601 UTC
  percentUsed: number; // 0-100
}

// ─── Module state ───

let broadcast: ((event: string, payload: unknown) => void) | null = null;
let maxConcurrency = 8;
let negativeTtlMs = 10_000;
let warnPercent = 20;
let critPercent = 5;

const etagCache = new Map<string, CacheEntry>(); // key: args.join('\0') → ETag + body
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

export function isGhPRChecksPendingExit(
  args: string[],
  err: { code?: unknown; stdout?: unknown },
): boolean {
  const code = typeof err.code === 'number' ? err.code : Number(err.code);
  return (
    args[0] === 'pr' &&
    args[1] === 'checks' &&
    code === 8 &&
    typeof err.stdout === 'string' &&
    err.stdout.trim().length > 0
  );
}

/**
 * Run `gh <args>` with ETag caching, rate-limit observation, and negative caching.
 * For non-`api` calls (e.g., `gh pr list`, `gh pr checks`), ETag/304 are not used
 * because gh porcelain subcommands don't support `--include`; the request still
 * flows through concurrency + negative cache.
 */
export async function ghRequest(args: string[], opts?: GhRequestOpts): Promise<CommandOutput> {
  const key = args.join('\0');
  const force = opts?.force === true;
  const signal = opts?.signal;
  const canShareInFlight = !force;

  // Negative cache: collapse repeated failures inside the TTL window.
  if (!force) {
    const neg = negativeCache.get(key);
    if (neg && Date.now() - neg.at < negativeTtlMs) throw neg.error;
  }

  if (canShareInFlight) {
    const existing = inFlight.get(key);
    if (existing) return attachSharedAbortSignal(existing, signal);
    const controller = new AbortController();
    const promise = runGh(args, key, force, controller.signal).finally(() => {
      inFlight.delete(key);
    });
    const entry: InFlightEntry = { promise, controller, refCount: 0 };
    inFlight.set(key, entry);
    return attachSharedAbortSignal(entry, signal);
  }

  // Forced calls bypass the in-flight share map; signal kills the child directly.
  return runGh(args, key, force, signal);
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

async function runGh(
  args: string[],
  key: string,
  force: boolean,
  signal?: AbortSignal,
): Promise<CommandOutput> {
  await acquire();
  try {
    const isApi = args[0] === 'api';
    const isPaginated = args.includes('--paginate');
    const useEtag = isApi && !isPaginated && !force;
    const cached = useEtag ? etagCache.get(key) : undefined;

    // Only `gh api --include` exposes headers. For porcelain subcommands and
    // `--paginate` calls, fall back to a plain call (no ETag/304 path since
    // paginated responses repeat status blocks per page).
    if (isApi && !isPaginated) {
      const ghArgs = cloneArgs(args);
      if (!ghArgs.includes('--include') && !ghArgs.includes('-i')) ghArgs.splice(1, 0, '--include');
      const headerFlags: string[] = [];
      if (cached) {
        headerFlags.push('-H', `If-None-Match: ${cached.etag}`);
        ghArgs.splice(1, 0, ...headerFlags);
      }
      const raw = await spawnGh(ghArgs, signal);
      const parsed = parseResponse(raw.stdout);
      updateQuotaFromHeaders(parsed.headers);

      if (parsed.status === 304 && cached) {
        return { stdout: cached.body, stderr: '' };
      }
      if (parsed.status >= 200 && parsed.status < 300) {
        const etag = parsed.headers.get('etag');
        if (etag) {
          etagCache.set(key, { etag, body: parsed.body, at: Date.now() });
          if (etagCache.size > 512) {
            const oldest = etagCache.keys().next().value;
            if (oldest !== undefined) etagCache.delete(oldest);
          }
        }
        return { stdout: parsed.body, stderr: raw.stderr };
      }
      const err = new Error(
        `gh api ${args.slice(1).join(' ')} failed: HTTP ${parsed.status} ${parsed.body.slice(0, 400)}`,
      );
      cacheNegative(key, err);
      throw err;
    }

    // Non-api: plain execFile, no ETag. Still de-duped and concurrency-bounded.
    const raw = await spawnGh(args, signal);
    return raw;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    if (!isAbortError(err)) cacheNegative(key, err);
    throw err;
  } finally {
    release();
  }
}

async function spawnGh(args: string[], signal?: AbortSignal): Promise<CommandOutput> {
  // Unset GH_TOKEN so `gh` uses the keyring token (full repo scope).
  const env = { ...process.env };
  delete env.GH_TOKEN;
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      env,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    return { stdout, stderr: stderr ?? '' };
  } catch (err) {
    if (isAbortError(err)) throw err;
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    // `gh api --include` exits non-zero on 304 Not Modified, but still writes
    // the full HTTP response (headers + empty body) to stdout. Surface the
    // stdout so runGh's ETag path can parse the 304 and serve the cached
    // body instead of treating this as a hard failure (which would poison
    // the negative cache for every identical read).
    if (
      args[0] === 'api' &&
      args.includes('--include') &&
      typeof e.stdout === 'string' &&
      /^HTTP\/[\d.]+\s+304/m.test(e.stdout)
    ) {
      return { stdout: e.stdout, stderr: e.stderr ?? '' };
    }
    // `gh pr checks` exits 8 when at least one check is pending, even though
    // stdout still contains the requested JSON/JQ output. Preserve that data
    // so PR status can show pending checks instead of an empty dashboard.
    if (isGhPRChecksPendingExit(args, e)) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
    throw new Error(`gh ${args.join(' ')} failed: ${e.stderr?.trim() || e.stderr || e.message}`);
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

function cloneArgs(args: string[]): string[] {
  return args.slice();
}

// ─── HTTP-ish response parsing (gh api --include) ───

interface ParsedResponse {
  status: number;
  headers: Map<string, string>;
  body: string;
}

function parseResponse(raw: string): ParsedResponse {
  // gh api --include emits: "HTTP/2.0 200 OK\r\n<headers>\r\n\r\n<body>"
  // It may prepend multiple status blocks on redirects; take the last one.
  const blocks = raw.split(/\r?\n\r?\n/);
  if (blocks.length < 2) {
    return { status: 0, headers: new Map(), body: raw };
  }
  // Find last block that starts with "HTTP/".
  let headerIdx = -1;
  for (let i = blocks.length - 2; i >= 0; i--) {
    if (/^HTTP\//.test(blocks[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return { status: 0, headers: new Map(), body: raw };

  const headerBlock = blocks[headerIdx];
  const body = blocks.slice(headerIdx + 1).join('\n\n');

  const lines = headerBlock.split(/\r?\n/);
  const statusLine = lines[0] ?? '';
  const statusMatch = statusLine.match(/^HTTP\/[\d.]+\s+(\d+)/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;

  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers, body };
}

function updateQuotaFromHeaders(headers: Map<string, string>): void {
  const remainingStr = headers.get('x-ratelimit-remaining');
  const limitStr = headers.get('x-ratelimit-limit');
  const resetStr = headers.get('x-ratelimit-reset');
  if (remainingStr == null || limitStr == null) return;

  const remaining = Number(remainingStr);
  const limit = Number(limitStr);
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return;

  const resetEpoch = resetStr ? Number(resetStr) : 0;
  const resetAt =
    Number.isFinite(resetEpoch) && resetEpoch > 0
      ? new Date(resetEpoch * 1000).toISOString()
      : new Date(0).toISOString();
  const percentUsed = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));

  quota = { remaining, limit, resetAt, percentUsed };

  const percentRemaining = (remaining / limit) * 100;
  const bucket: 'ok' | 'warn' | 'crit' =
    percentRemaining <= critPercent ? 'crit' : percentRemaining <= warnPercent ? 'warn' : 'ok';

  if (bucket !== lastQuotaBucket && broadcast) {
    broadcast(Events.GITHUB_RATE_LIMIT, { remaining, limit, resetAt, percentUsed });
    console.log(
      `[github-client] quota bucket ${lastQuotaBucket} → ${bucket} remaining=${remaining}/${limit} resetAt=${resetAt}`,
    );
    lastQuotaBucket = bucket;
  }
}
