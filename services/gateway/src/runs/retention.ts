import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { decisionArtifactBundleRef, type Run, type RunArtifactBundleRef } from '@farmslot/protocol';
import { resolveRetainedRunBundleRef } from '@farmslot/run-bundle';

import { runNeedsExecutionStorage } from '../review-workspaces/storage-use.js';

/** A settled run keeps its storage this long (ADR-039 Amendment 2). */
export const RUN_RETENTION_AGE_MS = 48 * 60 * 60 * 1000;

export type RunRetentionStore =
  | 'run-records'
  | 'session-archives'
  | 'task-dirs'
  | 'task-pins'
  | 'review-workspaces'
  | 'native-sessions'
  | 'run-bundles';

export interface RunRetentionRoots {
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

export interface RunRetentionContext {
  now: number;
  /** Whether the run's PR is open now; undefined when that could not be read. */
  prOpen: (run: Run) => boolean | undefined;
}

const time = (value: string | undefined) => (value ? Date.parse(value) || 0 : 0);

/** A PR the run record does not already show merged or closed. */
export function runPrUnsettled(run: Run): boolean {
  const hasPr = run.prNumber !== undefined || run.links?.some((link) => link.label === 'PR');
  return Boolean(hasPr) && !run.mergedAt && run.prState !== 'MERGED' && run.prState !== 'CLOSED';
}

/** Why a run keeps its storage, or undefined when retention may remove it. */
export function runRetentionHold(
  run: Run,
  { now, prOpen }: RunRetentionContext,
): string | undefined {
  if (!run.archivedAt && run.status !== 'done' && run.status !== 'cancelled')
    return 'not done, cancelled or archived';
  if (run.tags?.length) return 'operator-tagged';
  if (runNeedsExecutionStorage(run)) return 'still needs its execution storage';
  if (run.backlogReconcilePending) return 'backlog reconciliation pending';
  if (runPrUnsettled(run)) {
    const open = prOpen(run);
    if (open !== false) return open ? 'PR open' : 'PR state unknown';
  }
  const settledAt = Math.max(time(run.updatedAt), time(run.completedAt), time(run.archivedAt));
  if (now - settledAt < RUN_RETENTION_AGE_MS) return 'settled less than 48 h ago';
  return undefined;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

const taskDirs = (run: Run) =>
  [run.taskFile, run.activeTaskFile, ...(run.agentContexts ?? []).map((c) => c.taskFile)]
    .filter((file): file is string => typeof file === 'string')
    .map((file) => path.resolve(path.dirname(file)));

const nativeDirs = (run: Run) =>
  (run.agentContexts ?? [])
    .flatMap((context) => [context.nativeSession, ...(context.nativeSessionHistory ?? [])])
    .flatMap((session) =>
      session?.executionNodeId === 'local' && session.stateDirectory
        ? [path.resolve(session.stateDirectory)]
        : [],
    );

const reviewWorkspaceDirs = (run: Run) =>
  run.reviewWorkspace?.executionNodeId === 'local'
    ? [path.resolve(path.dirname(run.reviewWorkspace.checkoutPath))]
    : [];

function bundleDigests(run: Run, storeId: string): string[] {
  const refs: (RunArtifactBundleRef | undefined)[] = [
    run.artifactBundle,
    run.output?.artifactBundle,
    ...run.decisions.map((decision) => decisionArtifactBundleRef(run, decision.payload)),
  ];
  return refs.flatMap((ref) => {
    const resolved = ref && resolveRetainedRunBundleRef(run, ref);
    return resolved?.storeId === storeId ? [resolved.bundleDigest] : [];
  });
}

/** The run-owned paths of `removed` runs that no `kept` run references. */
export function runOwnedPaths(
  removed: Run[],
  kept: Run[],
  roots: RunRetentionRoots,
): Omit<RunRetentionPaths, 'task-pins'> {
  const owned = (paths: (run: Run) => string[], allowed: (file: string) => boolean) => {
    const keep = new Set(kept.flatMap(paths));
    return [...new Set(removed.flatMap(paths))].filter((file) => allowed(file) && !keep.has(file));
  };
  const bundles = roots.bundles;
  return {
    'run-records': removed.flatMap((run) => [
      path.join(roots.runsDir, `${run.id}.json`),
      path.join(roots.runsDir, 'archive', `${run.id}.json`),
    ]),
    'session-archives': removed.map((run) => roots.sessionArchive(run.id)),
    'task-dirs': owned(taskDirs, (dir) => roots.taskRoots.some((root) => inside(root, dir))),
    'review-workspaces': owned(reviewWorkspaceDirs, (dir) => inside(roots.reviewWorkspaces, dir)),
    'native-sessions': owned(nativeDirs, (dir) =>
      inside(path.join(roots.nativeSessions, 'workers'), dir),
    ),
    'run-bundles': bundles
      ? owned(
          (run) => bundleDigests(run, bundles.id),
          () => true,
        ).map((digest) => path.join(bundles.root, 'sha256', digest))
      : [],
  };
}

/**
 * A task pin serves one task directory for its lifetime. Once that directory is gone
 * the pin can no longer be used, so retention removes it after the retention age.
 */
export async function retiredTaskPins(
  pinRoot: string,
  removedTaskDirs: ReadonlySet<string>,
  now: number,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(pinRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const retired: string[] = [];
  for (const name of names) {
    const pin = path.join(pinRoot, name);
    const provenance = path.join(pin, 'provenance.json');
    let taskDir: unknown;
    let writtenAt: number;
    try {
      writtenAt = (await stat(provenance)).mtimeMs;
      taskDir = (JSON.parse(await readFile(provenance, 'utf8')) as { taskDir?: unknown }).taskDir;
    } catch {
      continue; // A pin still being written, or unreadable, is not retired.
    }
    if (typeof taskDir !== 'string' || now - writtenAt < RUN_RETENTION_AGE_MS) continue;
    const resolved = path.resolve(taskDir);
    if (removedTaskDirs.has(resolved) || !(await exists(resolved))) retired.push(pin);
  }
  return retired;
}

async function exists(file: string): Promise<boolean> {
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

/** Split runs into removable and held, then list the existing storage only removable runs own. */
export async function planRunRetention(
  runs: Run[],
  context: RunRetentionContext,
  roots: RunRetentionRoots,
  holdsSlot: (run: Run) => Promise<boolean>,
): Promise<{ plan: RunRetentionPlan; removable: Run[] }> {
  const { now } = context;
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
    'task-pins': await retiredTaskPins(roots.taskPins, new Set(owned['task-dirs']), now),
  };
  return { plan: await measureRetention(removable, held, candidates), removable };
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
    stores[store] = { entries: store === 'run-records' ? runs.length : present.length, bytes };
  }
  return { runs: runs.map((run) => run.id), held, paths, stores };
}
