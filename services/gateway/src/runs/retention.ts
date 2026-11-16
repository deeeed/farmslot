import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';
import { resolveRetainedRunBundleRef, runBundleRefs } from '@farmslot/run-bundle';

import { runNeedsExecutionStorage } from '../review-workspaces/storage-use.js';

import { isTaskDirectoryAdmitting, runTaskDirectories } from './store.js';
import { readTaskPins, retiredTaskPinsOf as retiredPins, type TaskPinEntry } from './task-pins.cjs';
export { readTaskPins, type TaskPinEntry };

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The one tag that keeps a run's storage in place. Archiving moves storage with a restore
 * manifest, so other tags (unsteered, perps, release, ...) no longer pin it: 222 runs were
 * held on the gateway's disk by an arbitrary tag (ADR-039 Amendment 3).
 */
export const RUN_RETENTION_KEEP_TAG = 'keep';

export type RunRetentionStore =
  | 'session-archives'
  | 'task-dirs'
  | 'task-pins'
  | 'review-workspaces'
  | 'native-sessions'
  | 'run-bundles';

export const retentionStoreAction = (store: string): 'deleted' | 'archived' =>
  store === 'task-pins' || store === 'review-workspaces' ? 'deleted' : 'archived';

export interface RunRetentionRoots {
  archiveRoot: string;
  runsDir: string;
  sessionArchive: (runId: string) => string;
  /** Farm-owned task roots; task directories elsewhere (slot checkouts) are never removed. */
  taskRoots: string[];
  taskPins: string;
  /** This gateway's own native and review-workspace roots; other nodes own theirs. */
  nativeSessions: string;
  reviewWorkspaces: string;
  bundles?: { id: string; root: string };
}

export type RunRetentionPaths = Record<RunRetentionStore, string[]>;

export interface RunRetentionPlan {
  runs: string[];
  /** Why the other runs keep their storage, counted per reason. */
  held: Record<string, number>;
  paths: RunRetentionPaths;
  stores: Record<RunRetentionStore, { entries: number; bytes: number }>;
}

/** `none`: no PR. `settled`: merged or closed. `unknown`: its state could not be read. */
export type RunPrState = 'none' | 'settled' | 'open' | 'unknown';

export interface RunRetentionContext {
  now: number;
  /** How long a settled run keeps its storage: `runBundleRetention.runRetentionDays` (ADR-039 Amendment 8). */
  ageMs: number;
  prState: (run: Run) => RunPrState;
  /** Why an unsettled run still reads this run's storage, if one does. */
  activeSource: (run: Run) => string | undefined;
}

const time = (value: string | undefined) => (value ? Date.parse(value) || 0 : 0);

export const runIsSettled = (run: Run) =>
  Boolean(run.archivedAt) || run.status === 'done' || run.status === 'cancelled';

/** Periodic bookkeeping (e.g. resource posture) keeps touching settled runs' updatedAt. */
export const runSettledAt = (run: Run) =>
  Math.max(time(run.completedAt), time(run.archivedAt)) || time(run.updatedAt);

function retentionAge(ageMs: number): string {
  const days = Number((ageMs / DAY_MS).toFixed(2));
  return days === 1 ? '1 day' : `${days} days`;
}

/** Why a run keeps its storage, or undefined when retention may remove it. */
export function runRetentionHold(
  run: Run,
  { now, ageMs, prState, activeSource }: RunRetentionContext,
): string | undefined {
  if (!runIsSettled(run)) return 'not done, cancelled or archived';
  if (run.tags?.includes(RUN_RETENTION_KEEP_TAG)) return 'tagged keep';
  if (runNeedsExecutionStorage(run)) return 'still needs its execution storage';
  if (run.backlogReconcilePending) return 'backlog reconciliation pending';
  const active = activeSource(run);
  if (active) return active;
  // Every run on an open PR keeps its storage, whatever its age (ADR-039 Amendment 8).
  const pr = prState(run);
  if (pr === 'open') return 'PR open';
  if (pr === 'unknown') return 'PR state unknown';
  if (now - runSettledAt(run) < ageMs) return `settled less than ${retentionAge(ageMs)} ago`;
  return undefined;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** This node's review-workspace directory, at `<root>/<owner>/runs/<workspace>`. */
const reviewWorkspaceDirs = (run: Run) =>
  run.reviewWorkspace?.executionNodeId === 'local'
    ? [path.resolve(path.dirname(run.reviewWorkspace.checkoutPath))]
    : [];

/** Native worker state on this node: its agents' sessions and its review workspace's own. */
function nativeDirs(run: Run, nativeRoot: string): string[] {
  const sessions = (run.agentContexts ?? [])
    .flatMap((context) => [context.nativeSession, ...(context.nativeSessionHistory ?? [])])
    .flatMap((session) =>
      session?.executionNodeId === 'local' && session.stateDirectory
        ? [path.resolve(session.stateDirectory)]
        : [],
    );
  const workspace = reviewWorkspaceDirs(run)[0];
  if (workspace) {
    const owner = path.basename(path.dirname(path.dirname(workspace)));
    sessions.push(path.join(nativeRoot, 'workers', owner, path.basename(workspace)));
  }
  return sessions;
}

const bundleDigests = (run: Run, storeId: string) =>
  runBundleRefs(run).flatMap(({ ref }) => {
    const resolved = resolveRetainedRunBundleRef(run, ref);
    return resolved.storeId === storeId ? [resolved.bundleDigest] : [];
  });

/** Storage kinds a run references by path; session archives and task pins are found otherwise. */
type OwnedPathKind = Exclude<RunRetentionStore, 'session-archives' | 'task-pins'>;
const OWNED_PATH_KINDS: readonly OwnedPathKind[] = [
  'task-dirs',
  'review-workspaces',
  'native-sessions',
  'run-bundles',
];

/** The paths (bundle digests for run bundles) one run references, by kind. */
type RunPathLists = Record<OwnedPathKind, string[]>;

function runPathLists(run: Run, roots: RunRetentionRoots): RunPathLists {
  return {
    'task-dirs': runTaskDirectories(run),
    'review-workspaces': reviewWorkspaceDirs(run),
    'native-sessions': nativeDirs(run, roots.nativeSessions),
    'run-bundles': roots.bundles ? bundleDigests(run, roots.bundles.id) : [],
  };
}

/** Whether retention may remove `file` of `kind` at all: only inside this gateway's own roots. */
function removablePath(kind: OwnedPathKind, file: string, roots: RunRetentionRoots): boolean {
  if (kind === 'task-dirs') return roots.taskRoots.some((root) => inside(root, file));
  if (kind === 'review-workspaces') return inside(roots.reviewWorkspaces, file);
  if (kind === 'native-sessions') return inside(path.join(roots.nativeSessions, 'workers'), file);
  return true;
}

type RunOwnedPaths = Omit<RunRetentionPaths, 'task-pins'>;

/** The paths of `removed` that are removable and that `isKept` does not claim, in their order. */
function ownedPaths(
  removed: Run[],
  removedLists: RunPathLists[],
  isKept: (kind: OwnedPathKind, file: string) => boolean,
  roots: RunRetentionRoots,
): RunOwnedPaths {
  const owned = (kind: OwnedPathKind) =>
    [...new Set(removedLists.flatMap((lists) => lists[kind]))].filter(
      (file) => removablePath(kind, file, roots) && !isKept(kind, file),
    );
  const bundles = roots.bundles;
  return {
    'session-archives': removed.map((run) => roots.sessionArchive(run.id)),
    'task-dirs': owned('task-dirs'),
    'review-workspaces': owned('review-workspaces'),
    'native-sessions': owned('native-sessions'),
    'run-bundles': bundles
      ? owned('run-bundles').map((digest) => path.join(bundles.root, 'sha256', digest))
      : [],
  };
}

/** The run-owned paths of `removed` runs that no `kept` run references. */
export function runOwnedPaths(
  removed: Run[],
  kept: Run[],
  roots: RunRetentionRoots,
): RunOwnedPaths {
  const keptLists = kept.map((run) => runPathLists(run, roots));
  const keep = new Map(
    OWNED_PATH_KINDS.map((kind) => [kind, new Set(keptLists.flatMap((lists) => lists[kind]))]),
  );
  return ownedPaths(
    removed,
    removed.map((run) => runPathLists(run, roots)),
    (kind, file) => keep.get(kind)!.has(file),
    roots,
  );
}

/**
 * Which other runs reference a candidate's storage, for one retention pass, without recomputing
 * every run's paths for every candidate. Archived records are never changed in place (the store
 * replaces the object on each write), so their paths are indexed once. Live runs are changed in
 * place, so their paths are computed again on every query.
 *
 * `view(live.filter(keeps), keeps).owned(run)` equals
 * `runOwnedPaths([run], [...stable, ...live].filter(keeps), roots)`.
 */
export class RetentionPathOwners {
  private readonly index = new Map<OwnedPathKind, Map<string, Run[]>>(
    OWNED_PATH_KINDS.map((kind) => [kind, new Map()]),
  );

  constructor(
    private readonly roots: RunRetentionRoots,
    stable: readonly Run[],
  ) {
    for (const run of stable) {
      const lists = runPathLists(run, roots);
      for (const kind of OWNED_PATH_KINDS) {
        const owners = this.index.get(kind)!;
        for (const file of new Set(lists[kind])) {
          const list = owners.get(file);
          if (list) list.push(run);
          else owners.set(file, [run]);
        }
      }
    }
  }

  /**
   * The kept runs as of now: every stable run for which `keeps` holds, and `keptLive`, live runs
   * the caller already chose. Their paths are read here, so take a new view after anything may
   * have changed them.
   */
  view(keptLive: readonly Run[], keeps: (other: Run) => boolean): RetentionOwnersView {
    const liveLists = keptLive.map((run) => runPathLists(run, this.roots));
    const isKept = (kind: OwnedPathKind, file: string) =>
      Boolean(this.index.get(kind)!.get(file)?.some(keeps)) ||
      liveLists.some((lists) => lists[kind].includes(file));
    return {
      owned: (run) => ownedPaths([run], [runPathLists(run, this.roots)], isKept, this.roots),
      keepsTaskDirectory: (dir) => isKept('task-dirs', dir),
    };
  }
}

/** What kept runs reference, at one moment of a retention pass. */
export interface RetentionOwnersView {
  /** Equals `runOwnedPaths([run], kept, roots)` for the view's kept runs. */
  owned(run: Run): RunOwnedPaths;
  /** Whether a kept run references task directory `dir`. */
  keepsTaskDirectory(dir: string): boolean;
}

/** Shared node-local eligibility, with this gateway's in-flight task admission guard. */
export function retiredTaskPinsOf(
  entries: readonly TaskPinEntry[],
  removedTaskDirs: ReadonlySet<string>,
  context: Pick<RunRetentionContext, 'now' | 'ageMs'>,
  pending: (dir: string) => boolean,
  present?: (pin: string) => Promise<boolean>,
): Promise<string[]> {
  return retiredPins(
    entries,
    removedTaskDirs,
    context,
    (dir) => pending(dir) || isTaskDirectoryAdmitting(dir),
    present,
  );
}

/**
 * A task pin serves one task directory for its lifetime. Once that directory is gone
 * the pin can no longer be used, so retention removes it after the retention age.
 */
export async function retiredTaskPins(
  pinRoot: string,
  removedTaskDirs: ReadonlySet<string>,
  context: Pick<RunRetentionContext, 'now' | 'ageMs'>,
  pendingTaskDirs: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  return retiredTaskPinsOf(await readTaskPins(pinRoot), removedTaskDirs, context, (dir) =>
    pendingTaskDirs.has(dir),
  );
}

/** Whether `file` exists, without following a final symlink. */
export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Allocated bytes under a path, as `du` counts them; symlinks are not followed. */
export async function diskBytes(file: string): Promise<number> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let bytes = info.blocks * 512;
  if (info.isDirectory())
    for (const name of await readdir(file)) bytes += await diskBytes(path.join(file, name));
  return bytes;
}

/** Keep the paths that exist and count their entries and bytes per store. */
export async function measureRetention(
  runs: Run[],
  held: Record<string, number>,
  candidates: RunRetentionPaths,
): Promise<RunRetentionPlan> {
  const paths = {} as RunRetentionPaths;
  const stores = {} as RunRetentionPlan['stores'];
  for (const [store, files] of Object.entries(candidates) as [RunRetentionStore, string[]][]) {
    const present: string[] = [];
    let bytes = 0;
    for (const file of files) {
      if (!(await exists(file))) continue;
      present.push(file);
      bytes += await diskBytes(file);
    }
    paths[store] = present;
    stores[store] = { entries: present.length, bytes };
  }
  return { runs: runs.map((run) => run.id), held, paths, stores };
}

/** Split runs into removable and held, then list the existing storage only removable runs own. */
export async function planRunRetention(
  runs: Run[],
  context: RunRetentionContext,
  roots: RunRetentionRoots,
  holdsSlot: (run: Run) => Promise<boolean>,
): Promise<{ plan: RunRetentionPlan; removable: Run[] }> {
  const held: Record<string, number> = {};
  const removable: Run[] = [];
  const kept: Run[] = [];
  for (const run of runs) {
    const reason =
      runRetentionHold(run, context) ?? ((await holdsSlot(run)) ? 'holds its slot' : '');
    if (reason) {
      held[reason] = (held[reason] ?? 0) + 1;
      kept.push(run);
    } else removable.push(run);
  }
  const owned = runOwnedPaths(removable, kept, roots);
  const candidates: RunRetentionPaths = {
    ...owned,
    'task-pins': await retiredTaskPins(
      roots.taskPins,
      new Set(owned['task-dirs']),
      context,
      new Set(kept.flatMap(runTaskDirectories)),
    ),
  };
  return { plan: await measureRetention(removable, held, candidates), removable };
}
