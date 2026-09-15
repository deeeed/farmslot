// list-cache.ts — gateway-owned warm copy of the PR dashboard list.
//
// `pr.list` fans out to GitHub for every candidate PR (slots + recent runs),
// which routinely takes seconds cold and used to run on every client
// bootstrap, poll, and page reload. The gateway now keeps the last result in
// memory and on disk (FARMSLOT_DIR/.farm-cache/pr-list.json), answers from it
// at once, refreshes in the background once it is older than
// PR_LIST_STALE_MS while a client is connected, and broadcasts
// `pr.list.updated` whenever a refresh changes the list.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import {
  Events,
  type PRListResult,
  type PRListUpdatedPayload,
  type PRStatus,
} from '@farmslot/protocol';

import { farmCacheFile } from '../../core/farm-cache.js';

export interface PRListSnapshot {
  fetchedAt: string;
  prs: PRStatus[];
  /** Candidate discovery hit its cap; project-scoped callers must not trust a filter of this copy. */
  truncated?: boolean;
}

/** `force` asks the fetcher to bypass its own GitHub caches; `failed` names PRs it could not read. */
type PRListFetcher = (
  force: boolean,
) => Promise<{ prs: PRStatus[]; truncated: boolean; failed?: string[] }>;
export type ServedPRList = PRListResult & { truncated: boolean };
type Broadcast = (event: string, payload: unknown) => void;

const CACHE_FILE_NAME = 'pr-list.json';
/** Bump when PRStatus fields the UI dereferences change shape; older files are ignored. */
const PR_LIST_SNAPSHOT_VERSION = 1;
/** A served list older than this triggers a background refresh. */
export const PR_LIST_STALE_MS = 60_000;
/** A PR GitHub keeps failing to read is carried from the previous copy for at most this long. */
export const PR_LIST_CARRY_MAX_MS = 60 * 60 * 1000;

let snapshot: PRListSnapshot | null = null;
let loaded = false;
let inflight: { promise: Promise<PRListSnapshot>; forced: boolean } | null = null;
let queuedForced: Promise<PRListSnapshot> | null = null;
let broadcastFn: Broadcast = () => {};
/** `repo#pr` → when the row first had to be carried because GitHub could not read it. */
const carriedSince = new Map<string, number>();

function cacheFile(): string {
  return farmCacheFile(CACHE_FILE_NAME);
}

interface StoredPRList extends PRListSnapshot {
  version: number;
  /** `repo#pr` → epoch ms the row first had to be carried; survives restarts so the 1h cap holds. */
  carriedSince?: Record<string, number>;
}

/** The fields clients dereference without guards; anything else is tolerated. */
function isPRStatusLike(value: unknown): value is PRStatus {
  const p = value as PRStatus;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.repo === 'string' &&
    typeof p.pr === 'number' &&
    typeof p.prState === 'string' &&
    Array.isArray(p.checks) &&
    Array.isArray(p.failedNames) &&
    Array.isArray(p.botComments) &&
    Array.isArray(p.actionableBotComments) &&
    typeof p.checkSummary === 'object' &&
    p.checkSummary !== null
  );
}

function isStoredPRList(value: unknown): value is StoredPRList {
  const v = value as StoredPRList;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.version === PR_LIST_SNAPSHOT_VERSION &&
    typeof v.fetchedAt === 'string' &&
    Array.isArray(v.prs) &&
    v.prs.every(isPRStatusLike)
  );
}

export function loadPRListCache(): void {
  loaded = true;
  const file = cacheFile();
  if (!existsSync(file)) {
    snapshot = null;
    return;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    carriedSince.clear();
    if (isStoredPRList(parsed)) {
      snapshot = { fetchedAt: parsed.fetchedAt, prs: parsed.prs, truncated: parsed.truncated };
      for (const [key, since] of Object.entries(parsed.carriedSince ?? {}))
        if (typeof since === 'number' && Number.isFinite(since)) carriedSince.set(key, since);
    } else snapshot = null;
    if (snapshot)
      console.log(
        `[pr.list] warm list: ${snapshot.prs.length} PR(s) fetched ${snapshot.fetchedAt} (${file})`,
      );
    else console.warn(`[pr.list] ignoring warm list at ${file}: unknown version or shape`);
  } catch (err) {
    // A corrupt snapshot only costs one cold fetch; the next refresh rewrites it.
    console.warn(`[pr.list] failed to read warm list ${file}: ${(err as Error).message}`);
    snapshot = null;
  }
}

function persist(next: PRListSnapshot): void {
  const file = cacheFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const stored: StoredPRList = {
      version: PR_LIST_SNAPSHOT_VERSION,
      ...next,
      ...(carriedSince.size ? { carriedSince: Object.fromEntries(carriedSince) } : {}),
    };
    writeFileSync(tmp, JSON.stringify(stored), 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    // Disk persistence is an optimisation for the next gateway start; the
    // in-memory copy already serves this process.
    console.error(`[pr.list] persist failed: ${(err as Error).message}`);
  }
}

/** Where refresh completions and failures are announced (`pr.list.updated`). */
export function setPRListBroadcast(broadcast: Broadcast): void {
  broadcastFn = broadcast;
}

export function resetPRListCacheForTests(): void {
  snapshot = null;
  loaded = false;
  inflight = null;
  queuedForced = null;
  broadcastFn = () => {};
  carriedSince.clear();
}

function ageMs(snap: PRListSnapshot, now: number): number {
  const fetched = Date.parse(snap.fetchedAt);
  return Number.isFinite(fetched) ? now - fetched : Number.POSITIVE_INFINITY;
}

/**
 * PRs GitHub could not be read for keep the row from the previous copy, so a
 * partial outage never turns a known MERGED PR into a blank OPEN placeholder.
 */
function withLastKnownState(prs: PRStatus[], failed: string[], now: number): PRStatus[] {
  const keys = new Set(failed);
  for (const key of carriedSince.keys()) if (!keys.has(key)) carriedSince.delete(key);
  if (failed.length === 0 || !snapshot) return prs;
  const carried: PRStatus[] = [];
  const expired: string[] = [];
  for (const row of snapshot.prs) {
    const key = `${row.repo}#${row.pr}`;
    if (!keys.has(key)) continue;
    const since = carriedSince.get(key) ?? now;
    carriedSince.set(key, since);
    // Bounded: a PR that was deleted, or whose repo access was revoked, reads
    // exactly like an outage, so it must not be carried forever.
    if (now - since > PR_LIST_CARRY_MAX_MS) {
      expired.push(key);
      carriedSince.delete(key);
      continue;
    }
    carried.push(row);
  }
  if (carried.length)
    console.warn(
      `[pr.list] kept last known state for ${carried.length} PR(s): ${carried.map((p) => `${p.repo}#${p.pr}`).join(', ')}`,
    );
  if (expired.length)
    console.warn(
      `[pr.list] dropped ${expired.length} unreadable PR(s) after 1h: ${expired.join(', ')}`,
    );
  return [...prs, ...carried];
}

function runRefresh(fetch: PRListFetcher, force: boolean, now: number): Promise<PRListSnapshot> {
  // Register before invoking so a fetcher that throws synchronously cannot
  // clear `inflight` first and leave a stale entry behind.
  let settle!: { resolve: (value: PRListSnapshot) => void; reject: (reason: unknown) => void };
  const entry = {
    promise: new Promise<PRListSnapshot>((resolve, reject) => {
      settle = { resolve, reject };
    }),
    forced: force,
  };
  inflight = entry;
  (async () => {
    try {
      const fetched = await fetch(force);
      const prs = withLastKnownState(fetched.prs, fetched.failed ?? [], now);
      const next: PRListSnapshot = {
        fetchedAt: new Date(now).toISOString(),
        prs,
        truncated: fetched.truncated,
      };
      const changed = !snapshot || JSON.stringify(snapshot.prs) !== JSON.stringify(prs);
      snapshot = next;
      persist(next);
      // Always announce completion so clients that were told `refreshing`
      // can clear it; ship the list only when it differs.
      const payload: PRListUpdatedPayload = changed
        ? { fetchedAt: next.fetchedAt, prs }
        : { fetchedAt: next.fetchedAt };
      broadcastFn(Events.PR_LIST_UPDATED, payload);
      return next;
    } catch (err) {
      // Every client that was told `refreshing` (not only the caller that
      // triggered this fetch) must hear that it ended, and how.
      announceFailure(err);
      throw err;
    } finally {
      if (inflight === entry) inflight = null;
    }
  })().then(settle.resolve, settle.reject);
  return entry.promise;
}

function announceFailure(err: unknown): void {
  const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
  const payload: PRListUpdatedPayload = { fetchedAt: snapshot?.fetchedAt, error: message };
  broadcastFn(Events.PR_LIST_UPDATED, payload);
}

/**
 * One fetch at a time. A forced refresh that arrives while a non-forced one
 * is running must still reach GitHub, so it is queued behind it (and shared
 * by any further forced callers) instead of being answered by that fetch.
 */
function refresh(fetch: PRListFetcher, force: boolean, now = Date.now()): Promise<PRListSnapshot> {
  if (!inflight) return runRefresh(fetch, force, now);
  if (!force || inflight.forced) return inflight.promise;
  queuedForced ??= inflight.promise
    .then(
      () => runRefresh(fetch, true, Date.now()),
      () => runRefresh(fetch, true, Date.now()),
    )
    .finally(() => {
      queuedForced = null;
    });
  return queuedForced;
}

/** A background refresh failed; the warm copy stays and runRefresh already announced it. */
function logBackgroundFailure(err: unknown): void {
  console.warn(
    `[pr.list] background refresh failed; keeping warm list: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
  );
}

/**
 * Answer a `pr.list` request. Cold or `force`: run the fetch and wait. Warm:
 * answer immediately and, when the copy is older than PR_LIST_STALE_MS, start
 * one background refresh whose result reaches clients as `pr.list.updated`.
 */
export async function servePRList(
  fetch: PRListFetcher,
  opts: { force?: boolean; now?: number } = {},
): Promise<ServedPRList> {
  if (!loaded) loadPRListCache();
  if (opts.force || !snapshot) {
    const fresh = await refresh(fetch, opts.force === true, opts.now);
    return {
      prs: fresh.prs,
      fetchedAt: fresh.fetchedAt,
      refreshing: false,
      truncated: fresh.truncated === true,
    };
  }
  if (ageMs(snapshot, opts.now ?? Date.now()) > PR_LIST_STALE_MS && !inflight)
    refresh(fetch, false, opts.now).catch(logBackgroundFailure);
  return {
    prs: snapshot.prs,
    fetchedAt: snapshot.fetchedAt,
    refreshing: inflight !== null,
    truncated: snapshot.truncated === true,
  };
}

/** Current warm copy, for callers that must not trigger a fetch. */
export function peekPRList(): PRListSnapshot | null {
  if (!loaded) loadPRListCache();
  return snapshot;
}

/**
 * Keep the warm list fresh while someone is looking: every `intervalMs`, if a
 * client is connected and the copy is stale, refresh it. Returns a stop function.
 */
export function startPRListRefresher(
  fetch: PRListFetcher,
  opts: {
    broadcast: Broadcast;
    hasClients: () => boolean;
    intervalMs?: number;
    initialDelayMs?: number;
  },
): () => void {
  setPRListBroadcast(opts.broadcast);
  if (!loaded) loadPRListCache();
  const tick = () => {
    if (!opts.hasClients() || inflight) return;
    if (snapshot && ageMs(snapshot, Date.now()) <= PR_LIST_STALE_MS) return;
    refresh(fetch, false).catch(logBackgroundFailure);
  };
  const initial = setTimeout(tick, opts.initialDelayMs ?? 3_000);
  initial.unref();
  const timer = setInterval(tick, opts.intervalMs ?? PR_LIST_STALE_MS);
  timer.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
