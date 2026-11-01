import type { ReviewWorkspaceSubject } from '../contracts/review-workspace.js';
import { awaitsHumanDecision } from '../contracts/run-lifecycle-view.js';
import type { ReadyGatePrPackage, ReviewDiffSnapshot, Run } from '../contracts/runs.js';
import type { GitDiffResult, GitLogResult, GitShowBatchResult } from '../rpc/git.js';
import { Methods } from '../rpc/registry.js';
import type { RunGetResult } from '../rpc/run.js';
import { isRunArtifactImagePath, isRunArtifactMediaPath } from '../runs/artifact-media.js';
import { reviewDiffHash } from '../runs/review-diff-identity.js';
import type { ResourceChangedPayload } from '../transport/events.js';

import {
  base64Bytes,
  gitBlobHash,
  RESOURCE_CONTENT_LIMITS,
  resourceContentWithinLimits,
} from './content.js';
import { applyUnifiedDiff, parseUnifiedDiff, type UnifiedDiffFile } from './diff-apply.js';
import { type ResourceQuery, resourceQuery } from './registry.js';
import type { ContentKey, ResourceContentCohort } from './store.js';
import type {
  GatewayResourceCache,
  ResourceCacheConnection,
  ResourceCacheTransport,
  ResourceContentInput,
  ResourceContentWriteToken,
  ResourceQueryState,
} from './types.js';

/** A pending gate or an active run the client lists. */
export interface ContentPrefetchTarget {
  runId: string;
  gate: boolean;
  /** Orders runs of the same kind, most recent first. */
  updatedAt?: string | number;
}

/** A retained run artifact, read from `/api/run-artifact` with its bundle digest. */
export interface ContentPrefetchArtifact {
  runId: string;
  path: string;
  bundleDigest?: string;
}

/** A pending gate's evidence too large for a content row: a video, or an image over the cap. */
export interface ContentPrefetchMediaEntry extends ContentPrefetchArtifact {
  sha256: string;
  sizeBytes?: number;
  /** The gate's last update, so the holder can drop the oldest gates first. */
  gateAt: number;
}

/**
 * Keeps a pending gate's large evidence as files, by digest. The client owns where the bytes
 * live, how much it keeps and on which networks it downloads; prefetch only says what the gate
 * needs. False skips that entry (no room, or not now) without stopping the gate's other reads.
 */
export interface ContentPrefetchMedia {
  hold(entry: ContentPrefetchMediaEntry, signal: AbortSignal): Promise<boolean>;
}

export interface ContentPrefetchOptions {
  /** The cache's transport: connection, capabilities and resource changes. */
  transport: Pick<
    ResourceCacheTransport,
    'getConnection' | 'onConnectionChange' | 'onResourceChanged'
  >;
  cache: Pick<
    GatewayResourceCache,
    'retry' | 'readContent' | 'storeContent' | 'retainContent' | 'contentWriteToken' | 'observedKey'
  >;
  /** Plain RPC for reads that are not stored queries: `git.show`, `git.log` and frozen `git.diff`. */
  request<T>(method: string, params: unknown, signal: AbortSignal): Promise<T>;
  /** Raw bytes. An authorization refusal rejects with `code: 'AUTH_FORBIDDEN'`. */
  readArtifact(artifact: ContentPrefetchArtifact, signal: AbortSignal): Promise<Uint8Array>;
  /** The run's project default branch, for an active run without a stack base (`activeRunDiffBase`). */
  defaultBranch?(run: Run): string | undefined;
  /** Large gate evidence (videos, images over the row cap); without it, they load when opened. */
  media?: ContentPrefetchMedia;
}

export interface ContentPrefetcher {
  /** Replaces the listed runs; a run no longer listed stops. */
  setTargets(targets: readonly ContentPrefetchTarget[]): void;
  dispose(): void;
}

/** Prefetch rule 1 (initial). */
const MAX_PREFETCH_RUNS = 2;
/**
 * A busy worktree changes every few seconds, but only a new head rereads its diff. Its head is
 * checked only while a view reads that slot, and then once a minute, so a busy farm's working
 * slots are not asked for their log in the background.
 */
const SLOT_HEAD_CHECK_INTERVAL_MS = 60_000;
const GITLINK_MODE = '160000';

type PrefetchPlan = 'gate' | 'slot' | 'frozen';

interface PrefetchRunState {
  target: ContentPrefetchTarget;
  status: 'queued' | 'running' | 'done';
  rerun: boolean;
  /** A `run.get` reply a package check already read. */
  run?: Run;
  controller?: AbortController;
  plan?: PrefetchPlan;
  slotId?: string;
  packageId?: string;
  head?: string;
  check: {
    controller?: AbortController;
    again: boolean;
    lastAt: number;
    timer?: ReturnType<typeof setTimeout>;
  };
}

/** One run's writes, under the cache write token taken before its first read. */
interface PrefetchWrite {
  cohort: ResourceContentCohort;
  signal: AbortSignal;
  token: ResourceContentWriteToken;
}

interface PrefetchFiles extends PrefetchWrite {
  text: string;
  base: string;
  head?: string;
  scope: { slotId: string; runId?: string };
  untrackedFiles?: ReviewDiffSnapshot['untrackedFiles'];
}

function isRefusal(error: unknown): boolean {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return code === 'AUTH_FORBIDDEN' || code === 'AUTH_REQUIRED';
}

function aborted(): Error {
  return Object.assign(new Error('Prefetch stopped'), { code: 'PREFETCH_ABORTED' });
}

/** Only a reply read after `since` counts; a stored stale result is not a read. */
function freshData<T>(state: ResourceQueryState<T>, since: number, signal: AbortSignal): T {
  if (signal.aborted) throw aborted();
  if (state.data !== undefined && (state.observedAt ?? -Infinity) >= since) return state.data;
  throw Object.assign(new Error(state.error?.message ?? 'The read did not complete'), {
    code: state.error?.code,
  });
}

function updatedAt(target: ContentPrefetchTarget): number {
  const value =
    typeof target.updatedAt === 'string' ? Date.parse(target.updatedAt) : target.updatedAt;
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

/**
 * The base an active run's diff compares with, in the gateway's `publicationBaseForRun` order:
 * the stack base, then the run's project default branch, then `main`.
 */
export function activeRunDiffBase<R extends Pick<Run, 'stack'>>(
  run: R,
  defaultBranch?: (run: R) => string | undefined,
): string {
  return run.stack?.retargetedTo ?? run.stack?.baseBranch ?? defaultBranch?.(run) ?? 'main';
}

/** The active-run diff prefetch keeps: merge-base to worktree, with untracked files. */
export function activeRunDiffQuery(params: {
  slotId: string;
  runId: string;
  base: string;
}): ResourceQuery<GitDiffResult> {
  return resourceQuery<GitDiffResult>(Methods.GIT_DIFF, {
    ...params,
    target: 'worktree',
    includeUntracked: true,
  });
}

function pendingPackage(run: Run): ReadyGatePrPackage | undefined {
  const packageId = run.engineState?.publishGate?.packageId;
  if (!packageId) return undefined;
  let current: ReadyGatePrPackage | undefined;
  for (const decision of run.decisions ?? [])
    if (decision.payload?.kind === 'ready' && decision.payload.prPackage?.id === packageId) {
      if (!decision.resolvedAt) return decision.payload.prPackage;
      current = decision.payload.prPackage;
    }
  // A run still waiting on a person keeps its current package, for example while a review it
  // requested runs and its ready decision is already resolved.
  return awaitsHumanDecision(run) ? current : undefined;
}

/**
 * Experimental Prefetch rules 1 to 6: fills the content cache for pending gates and active runs.
 * It reads only while the connection advertises `capabilities.batchedContent`, and never on a timer.
 */
export function createContentPrefetcher(options: ContentPrefetchOptions): ContentPrefetcher {
  const { cache, transport } = options;
  const runs = new Map<string, PrefetchRunState>();
  const encoder = new TextEncoder();
  // Bytes must survive the round trip, so a leading byte order mark stays text.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let connection = transport.getConnection();
  let enabled = prefetchEnabled(connection);
  let refused = false;
  let disposed = false;
  let running = 0;
  let generation = 0;

  function prefetchEnabled(next: ResourceCacheConnection): boolean {
    return (
      next.connected && next.foreground !== false && next.capabilities?.batchedContent === true
    );
  }

  function stopCheck(state: PrefetchRunState): void {
    state.check.controller?.abort();
    state.check.controller = undefined;
    if (state.check.timer !== undefined) clearTimeout(state.check.timer);
    state.check.timer = undefined;
    state.check.again = false;
  }

  function halt(): void {
    generation++;
    running = 0;
    for (const state of runs.values()) {
      state.controller?.abort();
      state.controller = undefined;
      if (state.status === 'running') state.status = 'queued';
      stopCheck(state);
    }
  }

  function refuse(): void {
    refused = true;
    halt();
  }

  function pump(): void {
    if (!enabled || refused || disposed) return;
    const queued = [...runs.values()]
      .filter((state) => state.status === 'queued')
      .sort(
        (a, b) =>
          Number(b.target.gate) - Number(a.target.gate) ||
          updatedAt(b.target) - updatedAt(a.target),
      );
    for (const state of queued) {
      if (running >= MAX_PREFETCH_RUNS) return;
      start(state);
    }
  }

  function start(state: PrefetchRunState): void {
    const ticket = generation;
    const controller = new AbortController();
    const prefetched = state.run;
    state.status = 'running';
    state.rerun = false;
    state.run = undefined;
    state.controller = controller;
    running++;
    void prefetchRun(state, prefetched, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted && isRefusal(error)) refuse();
      })
      .finally(() => {
        if (ticket !== generation) return;
        running--;
        state.controller = undefined;
        if (runs.get(state.target.runId) === state) state.status = state.rerun ? 'queued' : 'done';
        pump();
      });
  }

  function refetch(state: PrefetchRunState, run?: Run): void {
    if (state.status === 'running') {
      state.rerun = true;
      return;
    }
    state.status = 'queued';
    state.run = run;
    pump();
  }

  /**
   * Prefetch rule 3: one check in flight per run, and slot checks at most once a minute, only while
   * a view reads that slot. A check queued while the view was open is dropped once it closes.
   */
  function check(state: PrefetchRunState): void {
    const pending = state.check;
    if (!enabled || refused || disposed || (state.plan !== 'gate' && state.plan !== 'slot')) return;
    if (state.plan === 'slot' && !(state.slotId && viewed(state.slotId))) return;
    if (pending.controller) {
      pending.again = true;
      return;
    }
    if (pending.timer !== undefined) return;
    const interval = state.plan === 'slot' ? SLOT_HEAD_CHECK_INTERVAL_MS : 0;
    const wait = pending.lastAt + interval - Date.now();
    if (wait > 0) {
      pending.timer = setTimeout(() => {
        pending.timer = undefined;
        check(state);
      }, wait);
      return;
    }
    const ticket = generation;
    const controller = new AbortController();
    pending.controller = controller;
    pending.lastAt = Date.now();
    void checkRun(state, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted && isRefusal(error)) refuse();
      })
      .finally(() => {
        if (ticket !== generation || pending.controller !== controller) return;
        pending.controller = undefined;
        if (pending.again) {
          pending.again = false;
          check(state);
        }
      });
  }

  async function checkRun(state: PrefetchRunState, signal: AbortSignal): Promise<void> {
    if (state.plan === 'gate') {
      const run = await readRun(state.target.runId, signal);
      if (run.engineState?.publishGate?.packageId !== state.packageId) refetch(state, run);
      return;
    }
    const log = await options.request<GitLogResult>(
      Methods.GIT_LOG,
      { slotId: state.slotId, limit: 1 },
      signal,
    );
    const head = log.entries[0]?.hash;
    // Only a diff read successfully sets the head, so one that failed is tried at the next check.
    if (signal.aborted || head === state.head) return;
    refetch(state);
  }

  async function readRun(runId: string, signal: AbortSignal): Promise<Run> {
    const since = Date.now();
    const query = resourceQuery<RunGetResult>(Methods.RUN_GET, { runId });
    const state = await cache.retry(query, undefined, signal);
    return freshData(state, since, signal).run;
  }

  /** Over-cap and binary content loads when opened (Content rule 4); skipping it is no refusal. */
  async function store(
    key: ContentKey,
    data: Uint8Array,
    { cohort, signal, token }: PrefetchWrite,
    { untrackedFiles, alias }: Pick<ResourceContentInput, 'untrackedFiles' | 'alias'> = {},
  ): Promise<boolean> {
    if (signal.aborted) throw aborted();
    if (!resourceContentWithinLimits(key, data)) return true;
    return cache.storeContent({
      key,
      data,
      origin: 'prefetch',
      cohort,
      token,
      ...(untrackedFiles?.length ? { untrackedFiles } : {}),
      ...(alias ? { alias } : {}),
    });
  }

  /** Held content is reused, never transferred again; reuse by a gate promotes it to that cohort. */
  function retain(key: ContentKey, { cohort, token }: PrefetchWrite): Promise<boolean> {
    return cache.retainContent(key, { origin: 'prefetch', cohort, token });
  }

  async function readByPath(
    path: string,
    expected: string | undefined,
    input: PrefetchFiles,
  ): Promise<Uint8Array | undefined> {
    if (!expected || !input.head) return undefined;
    try {
      // The batched form carries raw bytes, so files that are not UTF-8 can verify too.
      const page = await options.request<GitShowBatchResult>(
        Methods.GIT_SHOW,
        { ...input.scope, ref: input.head, paths: [path] },
        input.signal,
      );
      const entry = page.entries[0];
      const data = entry?.status === 'ok' && base64Bytes(entry.content ?? '');
      return data && gitBlobHash(data) === expected ? data : undefined;
    } catch (error) {
      if (isRefusal(error) || input.signal.aborted) throw error;
      return undefined;
    }
  }

  /** Prefetch rule 4. False when the cache refused the result. */
  async function rebuild(
    file: UnifiedDiffFile,
    readBase: () => Promise<Uint8Array | undefined>,
    blobSha: string | undefined,
    input: PrefetchFiles,
  ): Promise<boolean> {
    if (!file.newPath) return true;
    const expected = blobSha ?? file.newId;
    if (expected && (await retain({ kind: 'blob', id: expected }, input))) return true;
    const base = await readBase();
    if (!base) return true;
    let data: Uint8Array | undefined = base;
    if (file.hunks.length || file.malformed) {
      const text = applyUnifiedDiff(decoder.decode(base), file);
      data = text === undefined ? undefined : encoder.encode(text);
    }
    if (data && expected && gitBlobHash(data) !== expected) data = undefined;
    data ??= await readByPath(file.newPath, expected, input);
    return !data || store({ kind: 'blob', id: gitBlobHash(data) }, data, input);
  }

  /** Base sides through batched `git.show`, then new sides. False when the cache refused. */
  async function prefetchFiles(input: PrefetchFiles): Promise<boolean> {
    const { signal } = input;
    const manifest = new Map((input.untrackedFiles ?? []).map((file) => [file.path, file.blobSha]));
    const files = parseUnifiedDiff(input.text).filter(
      (file) => !file.binary && file.oldMode !== GITLINK_MODE && file.newMode !== GITLINK_MODE,
    );
    for (const path of manifest.keys())
      if (!files.some((file) => file.newPath === path))
        files.push({ newPath: path, binary: false, malformed: false, hunks: [] });
    const byBase = new Map<string, UnifiedDiffFile[]>();
    const held = new Set<string>();
    for (const file of files) {
      if (!file.oldPath) continue;
      byBase.set(file.oldPath, [...(byBase.get(file.oldPath) ?? []), file]);
      const id = file.oldId;
      if (id && !held.has(id) && (await retain({ kind: 'blob', id }, input))) held.add(id);
    }
    const paths = [...byBase.keys()];
    let after: string | undefined;
    let more = paths.length > 0;
    while (more) {
      const page = await options.request<GitShowBatchResult>(
        Methods.GIT_SHOW,
        {
          ...input.scope,
          ref: input.base,
          paths,
          ...(held.size ? { have: [...held] } : {}),
          ...(after === undefined ? {} : { after }),
        },
        signal,
      );
      for (const entry of page.entries) {
        if (!entry.id || (entry.status !== 'ok' && entry.status !== 'held')) continue;
        const key: ContentKey = { kind: 'blob', id: entry.id };
        let data: Uint8Array | undefined;
        if (entry.status === 'ok') {
          data = base64Bytes(entry.content ?? '');
          if (gitBlobHash(data) !== entry.id) continue;
          if (!(await store(key, data, input))) return false;
        }
        // A held base is read only when one of its new sides is not held.
        const readBase = async () => (data ??= await cache.readContent(key));
        for (const file of byBase.get(entry.path) ?? [])
          if (!(await rebuild(file, readBase, manifest.get(file.newPath ?? ''), input)))
            return false;
      }
      more = page.hasMore && page.entries.length > 0;
      after = page.cursor;
    }
    const empty = async () => new Uint8Array();
    for (const file of files) {
      const blobSha = manifest.get(file.newPath ?? '');
      if (!file.oldPath && !(await rebuild(file, empty, blobSha, input))) return false;
    }
    return true;
  }

  async function prefetchGate(
    run: Run,
    prPackage: ReadyGatePrPackage,
    write: PrefetchWrite,
    gateAt: number,
  ): Promise<void> {
    const { signal } = write;
    const snapshot = prPackage.reviewSnapshot;
    const bundleDigest = prPackage.artifactBundle?.bundleDigest;
    if (snapshot?.diffPath && snapshot.diffHash) {
      const key: ContentKey = { kind: 'diff', id: snapshot.diffHash };
      let data = (await retain(key, write)) ? await cache.readContent(key) : undefined;
      if (!data) {
        const read = await options.readArtifact(
          { runId: run.id, path: snapshot.diffPath, bundleDigest },
          signal,
        );
        if (!(await store(key, read, write, { untrackedFiles: snapshot.untrackedFiles }))) return;
        if (resourceContentWithinLimits(key, read)) data = read;
      }
      // Prefetch rule 6: a snapshot not taken at the local merge-base loads its bases when opened.
      if (data && run.slotId && snapshot.baseSha && snapshot.source === 'local-git') {
        const stored = await prefetchFiles({
          text: decoder.decode(data),
          base: snapshot.baseSha,
          head: snapshot.headSha ?? prPackage.headSha,
          scope: { slotId: run.slotId },
          untrackedFiles: snapshot.untrackedFiles,
          ...write,
        });
        if (!stored) return;
      }
    }
    for (const entry of prPackage.evidenceManifest ?? []) {
      if (!entry.sha256 || !isRunArtifactMediaPath(entry.path)) continue;
      if (
        !isRunArtifactImagePath(entry.path) ||
        (entry.sizeBytes ?? 0) > RESOURCE_CONTENT_LIMITS.imageBytes
      ) {
        if (signal.aborted) throw aborted();
        await options.media?.hold(
          {
            runId: run.id,
            path: entry.path,
            bundleDigest,
            sha256: entry.sha256,
            sizeBytes: entry.sizeBytes,
            gateAt,
          },
          signal,
        );
        continue;
      }
      const key: ContentKey = { kind: 'artifact', id: entry.sha256 };
      if (await retain(key, write)) continue;
      const data = await options.readArtifact(
        { runId: run.id, path: entry.path, bundleDigest },
        signal,
      );
      if (!(await store(key, data, write))) return;
    }
  }

  /** The diff is the observed query result, kept by the cache as a stale prefetch snapshot. */
  async function prefetchSlot(
    state: PrefetchRunState,
    run: Run,
    slotId: string,
    write: PrefetchWrite,
  ): Promise<void> {
    const since = Date.now();
    const query = activeRunDiffQuery({
      slotId,
      runId: run.id,
      base: activeRunDiffBase(run, options.defaultBranch),
    });
    const placement = { origin: 'prefetch' as const, cohort: write.cohort };
    const diff = freshData(await cache.retry(query, placement, write.signal), since, write.signal);
    state.head = diff.headSha;
    if (
      diff.mergeBaseSha &&
      encoder.encode(diff.diff).byteLength <= RESOURCE_CONTENT_LIMITS.diffBytes
    )
      await prefetchFiles({
        text: diff.diff,
        base: diff.mergeBaseSha,
        head: diff.headSha,
        scope: { slotId },
        ...write,
      });
  }

  async function prefetchFrozen(
    run: Run,
    subject: ReviewWorkspaceSubject,
    write: PrefetchWrite,
  ): Promise<void> {
    const scope = { slotId: '', runId: run.id };
    const diff = await options.request<GitDiffResult>(
      Methods.GIT_DIFF,
      { ...scope, base: subject.baseSha, head: subject.headSha },
      write.signal,
    );
    const key: ContentKey = { kind: 'diff', id: reviewDiffHash(diff.diff) };
    const data = encoder.encode(diff.diff);
    // The alias lets a client find the diff offline from the run's frozen commits.
    const alias = `frozen-diff:${run.id}:${subject.baseSha}:${subject.headSha}`;
    if (!resourceContentWithinLimits(key, data) || !(await store(key, data, write, { alias })))
      return;
    if (diff.mergeBaseSha)
      await prefetchFiles({
        text: diff.diff,
        base: diff.mergeBaseSha,
        head: subject.headSha,
        scope,
        ...write,
      });
  }

  async function prefetchRun(
    state: PrefetchRunState,
    prefetched: Run | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const token = cache.contentWriteToken();
    const run = prefetched ?? (await readRun(state.target.runId, signal));
    const prPackage = pendingPackage(run);
    state.slotId = run.slotId ?? undefined;
    if (prPackage) {
      state.plan = 'gate';
      state.packageId = run.engineState?.publishGate?.packageId;
      return prefetchGate(
        run,
        prPackage,
        { cohort: 'gate', signal, token },
        updatedAt(state.target),
      );
    }
    const write: PrefetchWrite = { cohort: 'run', signal, token };
    if (run.reviewWorkspace && run.reviewWorkspaceSubject) {
      state.plan = 'frozen';
      return prefetchFrozen(run, run.reviewWorkspaceSubject, write);
    }
    state.plan = run.slotId ? 'slot' : undefined;
    if (run.slotId) return prefetchSlot(state, run, run.slotId, write);
  }

  function connectionChanged(next: ResourceCacheConnection): void {
    if (disposed) return;
    const nextEnabled = prefetchEnabled(next);
    const same = next.id === connection.id;
    connection = next;
    if (same && nextEnabled === enabled) return;
    halt();
    enabled = nextEnabled;
    if (!same) {
      refused = false;
      for (const state of runs.values()) {
        state.status = 'queued';
        state.run = undefined;
      }
    } else for (const state of runs.values()) if (state.status === 'done') check(state);
    pump();
  }

  function viewed(slotId: string): boolean {
    return (
      cache.observedKey?.(
        (key) => key.family === 'workspace' && 'slotId' in key && key.slotId === slotId,
      ) === true
    );
  }

  function resourceChanged(payload: ResourceChangedPayload): void {
    if (!enabled || refused || disposed) return;
    const changed = new Set<PrefetchRunState>();
    for (const { key } of payload.changes) {
      if (key.family === 'package') {
        // Every run write changes its package key; only a gate plan reads the package.
        const state = runs.get(key.runId);
        if (state?.plan === 'gate') changed.add(state);
      } else if (key.family === 'workspace' && 'slotId' in key)
        for (const state of runs.values())
          if (
            state.plan === 'slot' &&
            state.slotId === key.slotId &&
            (!key.runId || key.runId === state.target.runId)
          )
            changed.add(state);
    }
    for (const state of changed) check(state);
  }

  const unsubscribeConnection = transport.onConnectionChange(connectionChanged);
  const unsubscribeChanges = transport.onResourceChanged(resourceChanged);

  return {
    setTargets(targets) {
      if (disposed) return;
      const listed = new Map(targets.map((target) => [target.runId, target]));
      for (const [runId, state] of runs)
        if (!listed.has(runId)) {
          state.controller?.abort();
          stopCheck(state);
          runs.delete(runId);
        }
      for (const target of listed.values()) {
        const state = runs.get(target.runId);
        if (!state) {
          runs.set(target.runId, {
            target,
            status: 'queued',
            rerun: false,
            check: { again: false, lastAt: -Infinity },
          });
          continue;
        }
        const promoted = state.target.gate !== target.gate;
        state.target = target;
        if (promoted) refetch(state);
      }
      pump();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeConnection();
      unsubscribeChanges();
      halt();
      runs.clear();
    },
  };
}
