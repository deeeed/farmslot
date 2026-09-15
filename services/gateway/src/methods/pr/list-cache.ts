// list-cache.ts — gateway-owned warm copy of the PR dashboard list.
//
// `pr.list` fans out to GitHub for every candidate PR (slots + recent runs),
// which routinely takes seconds cold and used to run on every client
// bootstrap, poll, and page reload. The gateway now keeps the last result in
// memory and on disk (FARMSLOT_DIR/.farm-cache/pr-list.json), answers from it
// at once, refreshes in the background once it is older than
// PR_LIST_STALE_MS while a client is connected, and broadcasts
// `pr.list.updated` whenever a refresh changes the list.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  Events,
  type PRListResult,
  type PRListUpdatedPayload,
  type PRStatus,
} from '@farmslot/protocol';

import { farmslotRoot } from '../../core/config.js';

export interface PRListSnapshot {
  fetchedAt: string;
  prs: PRStatus[];
}

type PRListFetcher = () => Promise<PRStatus[]>;
type Broadcast = (event: string, payload: unknown) => void;

const CACHE_DIR_NAME = '.farm-cache';
const CACHE_FILE_NAME = 'pr-list.json';
/** A served list older than this triggers a background refresh. */
export const PR_LIST_STALE_MS = 60_000;

let snapshot: PRListSnapshot | null = null;
let loaded = false;
let inflight: Promise<PRListSnapshot> | null = null;
let broadcastFn: Broadcast = () => {};

function cacheFile(): string {
  const base =
    process.env.FARMSLOT_DIR && process.env.FARMSLOT_DIR.length > 0
      ? process.env.FARMSLOT_DIR
      : farmslotRoot;
  const dir = path.join(base, CACHE_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, CACHE_FILE_NAME);
}

function isSnapshot(value: unknown): value is PRListSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PRListSnapshot).fetchedAt === 'string' &&
    Array.isArray((value as PRListSnapshot).prs)
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
    snapshot = isSnapshot(parsed) ? parsed : null;
    if (snapshot)
      console.log(
        `[pr.list] warm list: ${snapshot.prs.length} PR(s) fetched ${snapshot.fetchedAt} (${file})`,
      );
    else console.warn(`[pr.list] ignoring malformed warm list at ${file}`);
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
    writeFileSync(tmp, JSON.stringify(next), 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    // Disk persistence is an optimisation for the next gateway start; the
    // in-memory copy already serves this process.
    console.error(`[pr.list] persist failed: ${(err as Error).message}`);
  }
}

export function resetPRListCacheForTests(): void {
  snapshot = null;
  loaded = false;
  inflight = null;
  broadcastFn = () => {};
}

function ageMs(snap: PRListSnapshot, now: number): number {
  const fetched = Date.parse(snap.fetchedAt);
  return Number.isFinite(fetched) ? now - fetched : Number.POSITIVE_INFINITY;
}

function refresh(fetch: PRListFetcher): Promise<PRListSnapshot> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const prs = await fetch();
      const next: PRListSnapshot = { fetchedAt: new Date().toISOString(), prs };
      const changed = !snapshot || JSON.stringify(snapshot.prs) !== JSON.stringify(prs);
      snapshot = next;
      persist(next);
      if (changed) broadcastFn(Events.PR_LIST_UPDATED, next satisfies PRListUpdatedPayload);
      return next;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

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
): Promise<PRListResult> {
  if (!loaded) loadPRListCache();
  if (opts.force || !snapshot) {
    const fresh = await refresh(fetch);
    return { prs: fresh.prs, fetchedAt: fresh.fetchedAt, refreshing: false };
  }
  if (ageMs(snapshot, opts.now ?? Date.now()) > PR_LIST_STALE_MS && !inflight)
    refresh(fetch).catch(logBackgroundFailure);
  return { prs: snapshot.prs, fetchedAt: snapshot.fetchedAt, refreshing: inflight !== null };
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
  broadcastFn = opts.broadcast;
  if (!loaded) loadPRListCache();
  const tick = () => {
    if (!opts.hasClients() || inflight) return;
    if (snapshot && ageMs(snapshot, Date.now()) <= PR_LIST_STALE_MS) return;
    refresh(fetch).catch(logBackgroundFailure);
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
