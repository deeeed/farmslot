// Gateway-owned PR observations. Each normalized scope shares one retained value and collector.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import {
  Events,
  Methods,
  type PRListResult,
  type PRListUpdatedPayload,
  type PRStatus,
  type UpstreamObservation,
} from '@farmslot/protocol';
import { resourceCollectorQuery, type ResourceKey } from '@farmslot/protocol/client-cache';

import { farmCacheFile } from '../../core/farm-cache.js';
import { GatewayMethodError } from '../../core/method-error.js';
import { githubQueryBudget } from '../../integrations/github-query-budget.js';
import { resourceRevisions } from '../../resources/revisions.js';
import { upstreamObservers } from '../../resources/upstream-observers.js';

import {
  onPRRawObservation,
  restoreRetainedPRRawObservations,
  type RetainedPRRawObservation,
  retainedPRRawObservations,
} from './raw-cache.js';

export interface PRListSnapshot {
  fetchedAt: string;
  prs: PRStatus[];
  truncated?: boolean;
}

export interface PRListClientInterest {
  legacyInterest?: boolean;
  legacyClientId?: string;
}

interface PRListFetchResult {
  prs: PRStatus[];
  truncated: boolean;
  failed?: string[];
}

type PRListFetcher = (force: boolean) => Promise<PRListFetchResult>;
export type ServedPRList = PRListResult & { truncated: boolean };
type Broadcast = (event: string, payload: unknown) => void;

interface CollectorState {
  id: string;
  project?: string;
  loaded: boolean;
  snapshot: PRListSnapshot | null;
  carriedSince: Map<string, number>;
  legacyInterest: Map<string | symbol, number>;
  fetch?: PRListFetcher;
  inflight?: { promise: Promise<PRListSnapshot>; forced: boolean };
  queuedForced?: Promise<PRListSnapshot>;
  attemptedAt?: number;
  successfulObservedAt?: number;
  failure?: { message: string; cause: unknown; code?: string };
  incomplete: boolean;
  unchangedStreak: number;
  lastUsed: number;
}

interface StoredPRList extends PRListSnapshot {
  version: number;
  project?: string;
  carriedSince?: Record<string, number>;
  observation?: UpstreamObservation;
  attemptedAt?: number;
  incomplete?: boolean;
  raw?: RetainedPRRawObservation[];
}

export const PR_LIST_STALE_MS = 60_000;
export const PR_LIST_CLIENT_INTEREST_MS = 6 * 60_000;
export const PR_LIST_CARRY_MAX_MS = 60 * 60 * 1000;
const MAX_COLLECTORS = 128;
const BACKOFF_MS = [PR_LIST_STALE_MS, 2 * 60_000, 5 * 60_000] as const;
const anonymousLegacyClient = Symbol('legacy-pr-list-reader');
const collectors = new Map<string, CollectorState>();
let broadcastFn: Broadcast = () => {};
let lastReserveLogAt = 0;
let useSerial = 0;
let wakeCollector: (() => void) | undefined;
let wakeQueued = false;

/** Wake the existing eligibility-gated collector; this introduces no second timer. */
export function notifyPRListInterest(): void {
  if (wakeQueued) return;
  wakeQueued = true;
  queueMicrotask(() => {
    wakeQueued = false;
    wakeCollector?.();
  });
}

export function prListResourceKey(project?: string): ResourceKey {
  const query = resourceCollectorQuery(Methods.PR_LIST, project === undefined ? {} : { project });
  return { family: 'upstream', integration: 'github', queryId: query.id };
}

function cacheFile(project?: string): string {
  return farmCacheFile(
    project === undefined
      ? 'pr-list.json'
      : `pr-list-${createHash('sha256').update(project).digest('hex')}.json`,
  );
}

function hasLegacyInterest(state: CollectorState, now: number): boolean {
  for (const [client, at] of state.legacyInterest)
    if (now - at > PR_LIST_CLIENT_INTEREST_MS) state.legacyInterest.delete(client);
  return state.legacyInterest.size > 0;
}

function observerInterest(project?: string): boolean {
  return upstreamObservers.hasInterest(Methods.PR_LIST, project === undefined ? {} : { project });
}

function stateFor(project?: string): CollectorState {
  const query = resourceCollectorQuery(Methods.PR_LIST, project === undefined ? {} : { project });
  let state = collectors.get(query.id);
  if (!state) {
    if (collectors.size >= MAX_COLLECTORS) {
      const oldest = [...collectors.values()]
        .filter(
          (entry) =>
            !entry.inflight &&
            !entry.queuedForced &&
            !hasLegacyInterest(entry, Date.now()) &&
            !observerInterest(entry.project),
        )
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest)
        throw new GatewayMethodError('RESOURCE_LIMIT', 'Too many active upstream PR queries');
      collectors.delete(oldest.id);
      const file = cacheFile(oldest.project);
      if (existsSync(file)) unlinkSync(file);
    }
    state = {
      id: query.id,
      project,
      loaded: false,
      snapshot: null,
      carriedSince: new Map(),
      legacyInterest: new Map(),
      incomplete: false,
      unchangedStreak: 0,
      lastUsed: ++useSerial,
    };
    collectors.set(query.id, state);
  }
  state.lastUsed = ++useSerial;
  return state;
}

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

function observation(state: CollectorState): UpstreamObservation {
  const observedAt = state.successfulObservedAt;
  const stale = Boolean(
    state.inflight || state.failure || state.incomplete || observedAt === undefined,
  );
  return {
    status: state.snapshot ? (stale ? 'stale' : 'ready') : 'error',
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(state.failure
      ? {
          error: {
            code: state.failure.code ?? 'UPSTREAM_UNAVAILABLE',
            message: state.failure.message,
          },
        }
      : state.incomplete
        ? { error: { code: 'UPSTREAM_INCOMPLETE', message: 'The upstream PR list is incomplete' } }
        : {}),
  };
}

export function loadPRListCache(project?: string): void {
  const state = stateFor(project);
  state.loaded = true;
  state.snapshot = null;
  state.carriedSince.clear();
  state.failure = undefined;
  state.attemptedAt = undefined;
  state.successfulObservedAt = undefined;
  state.incomplete = false;
  const file = cacheFile(project);
  if (!existsSync(file)) return;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const value = parsed as StoredPRList;
    if (
      !value ||
      value.version !== 1 ||
      value.project !== project ||
      typeof value.fetchedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.fetchedAt)) ||
      !Array.isArray(value.prs) ||
      !value.prs.every(isPRStatusLike)
    ) {
      console.warn(`[pr.list] ignoring invalid warm snapshot at ${file}`);
      return;
    }
    state.snapshot = { fetchedAt: value.fetchedAt, prs: value.prs, truncated: value.truncated };
    for (const [key, at] of Object.entries(value.carriedSince ?? {}))
      if (typeof at === 'number' && Number.isFinite(at)) state.carriedSince.set(key, at);
    state.attemptedAt = Number.isFinite(value.attemptedAt) ? value.attemptedAt : undefined;
    const sourceTime = value.observation
      ? value.observation.observedAt
      : state.carriedSince.size
        ? undefined
        : Date.parse(value.fetchedAt);
    if (typeof sourceTime === 'number' && Number.isFinite(sourceTime) && sourceTime > 0)
      state.successfulObservedAt = sourceTime;
    if (value.observation?.error)
      state.failure = {
        ...value.observation.error,
        cause: new Error(value.observation.error.message),
      };
    state.incomplete = value.incomplete === true || state.carriedSince.size > 0;
    restoreRetainedPRRawObservations(value.raw);
  } catch (error) {
    // A corrupt optional warm copy costs a cold collection; no saved result becomes current.
    state.snapshot = null;
    console.warn(`[pr.list] cannot load warm snapshot ${file}: ${(error as Error).message}`);
  }
}

function ensureLoaded(state: CollectorState): void {
  if (!state.loaded) loadPRListCache(state.project);
}

function persist(state: CollectorState): void {
  if (!state.snapshot) return;
  const file = cacheFile(state.project);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const stored: StoredPRList = {
      version: 1,
      ...state.snapshot,
      ...(state.project === undefined ? {} : { project: state.project }),
      observation: observation(state),
      attemptedAt: state.attemptedAt,
      incomplete: state.incomplete,
      raw: retainedPRRawObservations(state.snapshot.prs),
      ...(state.carriedSince.size ? { carriedSince: Object.fromEntries(state.carriedSince) } : {}),
    };
    writeFileSync(tmp, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    // The readable in-memory observation survives an optional disk-cache write failure.
    console.error(`[pr.list] persist failed: ${(error as Error).message}`);
  }
}

function publish(state: CollectorState): void {
  resourceRevisions.advance(prListResourceKey(state.project));
}

export function setPRListBroadcast(broadcast: Broadcast): void {
  broadcastFn = broadcast;
}

export function resetPRListCacheForTests(): void {
  collectors.clear();
  broadcastFn = () => {};
  lastReserveLogAt = 0;
  useSerial = 0;
}

export function forgetPRListClientInterest(clientId: string): void {
  for (const state of collectors.values()) state.legacyInterest.delete(clientId);
}

function delayMs(state: CollectorState): number {
  return BACKOFF_MS[Math.min(state.unchangedStreak, BACKOFF_MS.length - 1)];
}

function eligible(state: CollectorState, now: number): boolean {
  return state.attemptedAt === undefined || now - state.attemptedAt >= PR_LIST_STALE_MS;
}

function budgetReserved(now: number): boolean {
  const retryAt = githubQueryBudget.anyReserved(now);
  if (!retryAt) return false;
  if (now - lastReserveLogAt > PR_LIST_STALE_MS) {
    lastReserveLogAt = now;
    console.warn(`[pr.list] GraphQL budget reserved until ${retryAt}; keeping warm list`);
  }
  return true;
}

function carryLastKnown(
  state: CollectorState,
  prs: PRStatus[],
  failed: string[],
  now: number,
): PRStatus[] {
  const keys = new Set(failed);
  for (const key of state.carriedSince.keys()) if (!keys.has(key)) state.carriedSince.delete(key);
  if (!state.snapshot || !failed.length) return prs;
  const carried: PRStatus[] = [];
  for (const row of state.snapshot.prs) {
    const key = `${row.repo}#${row.pr}`;
    if (!keys.has(key)) continue;
    const since = state.carriedSince.get(key) ?? now;
    state.carriedSince.set(key, since);
    if (now - since > PR_LIST_CARRY_MAX_MS) {
      state.carriedSince.delete(key);
      continue;
    }
    carried.push(row);
  }
  return [...prs, ...carried];
}

function announce(state: CollectorState, changed: boolean): void {
  // Legacy payload adoption owns only the farm list; a scoped result must never replace it.
  if (state.project !== undefined) return;
  const payload: PRListUpdatedPayload = state.failure
    ? { fetchedAt: state.snapshot?.fetchedAt, error: state.failure.message }
    : { fetchedAt: state.snapshot?.fetchedAt, ...(changed ? { prs: state.snapshot?.prs } : {}) };
  broadcastFn(Events.PR_LIST_UPDATED, payload);
}

function runRefresh(
  state: CollectorState,
  fetch: PRListFetcher,
  force: boolean,
  now: number,
): Promise<PRListSnapshot> {
  state.attemptedAt = now;
  const previous = state.snapshot;
  let settle!: { resolve(value: PRListSnapshot): void; reject(error: unknown): void };
  const entry = {
    promise: new Promise<PRListSnapshot>((resolve, reject) => {
      settle = { resolve, reject };
    }),
    forced: force,
  };
  state.inflight = entry;
  // The in-progress/freshness transition is readable before its notice.
  publish(state);
  (async () => {
    try {
      const fetched = await fetch(force);
      if (collectors.get(state.id) !== state)
        throw new GatewayMethodError('UPSTREAM_OBSOLETE', 'PR collector was retired');
      const failed = fetched.failed ?? [];
      const prs = carryLastKnown(state, fetched.prs, failed, now);
      const next = {
        fetchedAt: failed.length && previous ? previous.fetchedAt : new Date(now).toISOString(),
        prs,
        truncated: fetched.truncated,
      };
      const changed =
        !previous ||
        JSON.stringify(previous.prs) !== JSON.stringify(prs) ||
        previous.truncated !== next.truncated;
      state.snapshot = next;
      if (!failed.length) state.successfulObservedAt = now;
      state.incomplete = failed.length > 0 || fetched.truncated;
      state.failure = failed.length
        ? {
            message: `GitHub could not read ${failed.length} pull request(s): ${failed.join(', ').slice(0, 160)}`,
            cause: new Error('Partial upstream observation'),
            code: 'UPSTREAM_INCOMPLETE',
          }
        : undefined;
      state.unchangedStreak = changed ? 0 : state.unchangedStreak + 1;
      persist(state);
      announce(state, changed);
      return next;
    } catch (error) {
      if (collectors.get(state.id) === state) {
        state.failure = {
          message:
            error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
          cause: error,
        };
        persist(state);
        announce(state, false);
      }
      throw error;
    } finally {
      if (state.inflight === entry) state.inflight = undefined;
      if (collectors.get(state.id) === state) publish(state);
    }
  })().then(settle.resolve, settle.reject);
  return entry.promise;
}

function refresh(
  state: CollectorState,
  fetch: PRListFetcher,
  force: boolean,
  now: number,
): Promise<PRListSnapshot> {
  if (!state.inflight) return runRefresh(state, fetch, force, now);
  if (!force || state.inflight.forced) return state.inflight.promise;
  state.queuedForced ??= state.inflight.promise
    .then(
      () => runRefresh(state, fetch, true, Date.now()),
      () => runRefresh(state, fetch, true, Date.now()),
    )
    .finally(() => {
      state.queuedForced = undefined;
    });
  return state.queuedForced;
}

function backgroundFailure(error: unknown): void {
  // The observation now retains the error beside its last success and has notified readers.
  console.warn(
    `[pr.list] background collection failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
  );
}

export async function servePRList(
  fetch: PRListFetcher,
  opts: PRListClientInterest & { force?: boolean; now?: number; project?: string } = {},
): Promise<ServedPRList> {
  const state = stateFor(opts.project);
  ensureLoaded(state);
  state.fetch = fetch;
  const now = opts.now ?? Date.now();
  if (opts.legacyInterest !== false)
    state.legacyInterest.set(opts.legacyClientId ?? anonymousLegacyClient, now);
  // A complete farm snapshot can seed a project observation without a second upstream read.
  if (!state.snapshot && opts.project !== undefined && !opts.force) {
    const global = collectors.get(resourceCollectorQuery(Methods.PR_LIST).id);
    if (global?.snapshot && !global.snapshot.truncated) {
      state.snapshot = {
        ...global.snapshot,
        prs: global.snapshot.prs.filter((row) => row.project === opts.project),
      };
      state.attemptedAt = global.attemptedAt;
      state.successfulObservedAt = global.successfulObservedAt;
      state.failure = global.failure;
      state.incomplete = global.incomplete;
      persist(state);
    }
  }
  if (!opts.force && !state.snapshot && !state.inflight && !eligible(state, now) && state.failure)
    throw state.failure.cause;
  if (opts.force || !state.snapshot) await refresh(state, fetch, opts.force === true, now);
  else if (
    opts.legacyInterest !== false &&
    now - Date.parse(state.snapshot.fetchedAt) > delayMs(state) &&
    !state.inflight &&
    eligible(state, now) &&
    !budgetReserved(now)
  )
    refresh(state, fetch, false, now).catch(backgroundFailure);
  const snapshot = state.snapshot!;
  return {
    prs: snapshot.prs,
    fetchedAt: snapshot.fetchedAt,
    refreshing: Boolean(state.inflight),
    truncated: snapshot.truncated === true,
    observation: observation(state),
  };
}

export function peekPRList(project?: string): PRListSnapshot | null {
  const state = stateFor(project);
  ensureLoaded(state);
  return state.snapshot;
}

export function startPRListRefresher(
  fetch: PRListFetcher,
  opts: {
    broadcast: Broadcast;
    hasClients(): boolean;
    hasObservers?(project?: string): boolean;
    intervalMs?: number;
    initialDelayMs?: number;
  },
): () => void {
  setPRListBroadcast(opts.broadcast);
  const global = stateFor();
  ensureLoaded(global);
  global.fetch = fetch;
  const tick = () => {
    const now = Date.now();
    if (!opts.hasClients() || budgetReserved(now)) return;
    for (const state of collectors.values()) {
      if (!state.fetch || state.inflight || state.queuedForced) continue;
      if (
        !(opts.hasObservers?.(state.project) ?? observerInterest(state.project)) &&
        !hasLegacyInterest(state, now)
      )
        continue;
      if (!eligible(state, now)) continue;
      if (state.snapshot && now - Date.parse(state.snapshot.fetchedAt) <= delayMs(state)) continue;
      refresh(state, state.fetch, false, now).catch(backgroundFailure);
    }
  };
  wakeCollector = tick;
  const initial = setTimeout(tick, opts.initialDelayMs ?? 3000);
  const timer = setInterval(tick, opts.intervalMs ?? PR_LIST_STALE_MS);
  initial.unref();
  timer.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
    if (wakeCollector === tick) wakeCollector = undefined;
  };
}

onPRRawObservation((repo, pr) => {
  for (const state of collectors.values()) {
    if (
      state.inflight ||
      !state.snapshot?.prs.some(
        (row) => row.repo.toLowerCase() === repo.toLowerCase() && row.pr === pr,
      )
    )
      continue;
    // Active CI can observe newer raw bytes without changing its own scheduling policy.
    persist(state);
    publish(state);
  }
});
