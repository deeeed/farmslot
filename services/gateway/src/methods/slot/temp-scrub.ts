import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  isSlotFreedByPark,
  isTerminalRunStatus,
  type Run,
  type TempScrubReasonEntry,
  type TempScrubReceipt,
  type TempScrubRemovedEntry,
} from '@farmslot/protocol';

import { resolveProjectRuntimeDirName, resolveProjectTaskDirName } from '../../core/config.js';
import { type RawProjectJson, readSlotRow, type SlotVars } from '../../core/index.js';
import {
  CHECKOUT_KINDS,
  listTempTaskDirs,
  scrubSlotTemp,
  TEMP_TASK_ROOT,
  type TempScrubResult,
} from '../../fleet/temp-scrub.js';
import { retainedRunTaskDirectory } from '../../run-completion/retained-artifacts.js';
import { workerTaskDirectory } from '../../run-engine/worker-task-dir.js';
import { getRunWithArchived, listRunsForSlotHistory } from '../../runs/store.js';
import { slotPinIsRequestOnly } from '../dispatch/slot-scoring.js';

/**
 * What a slot keeps in temp/ between runs: `temp/farmslot` (deps stamps and locks, CI parity),
 * the runtime dir, the recipe harness, the dirs of the project's watched resource files (dev
 * server and browser pid files and their profiles), the preflight pid and Spotlight's opt-out.
 * This is farm state; a pack that writes run output into it cleans that itself.
 */
export function tempStatePaths(projectJson: RawProjectJson): string[] {
  const runtime = resolveProjectRuntimeDirName(projectJson);
  const watched = Object.values(projectJson.resources ?? {}).flatMap((resource) => {
    const watchPath = resource.watch?.path?.replaceAll('{{runtime_dir}}', runtime);
    if (!watchPath) return [];
    const file = path.posix.normalize(watchPath);
    const dir = path.posix.dirname(file);
    // A pid file directly in temp/ keeps only itself.
    return [dir === 'temp' ? file : dir];
  });
  return [
    ...new Set(
      [
        'temp/farmslot',
        runtime,
        'temp/recipe/harness',
        ...watched,
        'temp/.agent/preflight.pid',
        'temp/.metadata_never_index',
      ].filter((entry) => entry.startsWith('temp/') && !entry.includes('..')),
    ),
  ];
}

/** A run's task dir on the slot, relative to the checkout (the worker keeps flow and folder). */
export function slotTaskRelDir(run: Pick<Run, 'taskFile'>, taskDirName: string): string | null {
  return run.taskFile
    ? workerTaskDirectory(run.taskFile, '', taskDirName).replace(/^\/+/, '')
    : null;
}

export type BundleCheck =
  | { confirmed: true; taskDir: string }
  | { confirmed: false; reason: string };

/**
 * Whether the run's final bundle holds this task: the final ref, a complete capture, a bundle
 * record naming the run's task folder, and `TASK.md` plus every recorded artifact in its copy.
 * Prepare only names what it removes with this; it decides nothing.
 */
export async function taskBundleCheck(run: Run): Promise<BundleCheck> {
  const ref = run.output?.artifactBundle;
  if (!isTerminalRunStatus(run.status)) return { confirmed: false, reason: 'run not finished' };
  if (!ref || !run.taskFile) return { confirmed: false, reason: 'no final bundle' };
  if (run.output?.captureError) return { confirmed: false, reason: 'capture failed' };
  if (run.output?.retentionMissingData?.length)
    return { confirmed: false, reason: 'capture incomplete' };
  const taskDir = await retainedRunTaskDirectory(run, ref);
  const manifest = path.join(path.dirname(path.dirname(taskDir)), 'manifest.json');
  const recorded: unknown = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, 'utf8'))
    : null;
  const folder = path.posix.join(
    path.basename(path.dirname(path.dirname(run.taskFile))),
    path.basename(path.dirname(run.taskFile)),
  );
  const runs =
    recorded && typeof recorded === 'object' && 'runs' in recorded && Array.isArray(recorded.runs)
      ? recorded.runs
      : [];
  const entry: unknown = runs.find(
    (candidate: unknown) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'originalRunId' in candidate &&
      candidate.originalRunId === run.id,
  );
  const taskPath =
    entry && typeof entry === 'object' && 'taskRelativePath' in entry
      ? entry.taskRelativePath
      : undefined;
  if (typeof taskPath !== 'string' || (taskPath !== folder && !taskPath.endsWith(`/${folder}`)))
    return { confirmed: false, reason: 'bundle record names another task' };
  if (!existsSync(path.join(taskDir, 'TASK.md')))
    return { confirmed: false, reason: 'bundle lacks TASK.md' };
  const missing = run.output!.artifactManifest.find(
    (artifact) => !existsSync(path.join(taskDir, artifact.path)),
  );
  return missing
    ? { confirmed: false, reason: `bundle lacks ${missing.path}` }
    : { confirmed: true, taskDir };
}

/** A new run's prepare clears temp/; a warm handoff, a replay or a resumed task keeps it. */
export function shouldScrubTempForRun(run: Run | undefined): run is Run {
  if (!run) return false;
  const flags = run.engineState?.flags;
  if (flags?.warmSessionReuse && flags.warmHandoffSucceeded !== false) return false;
  const init = run.engineState?.taskInit;
  if (init?.status === 'initialized' && init.taskFile === run.taskFile) return false;
  return !run.steps.some((entry) => entry.name === 'dispatch' && entry.status === 'done');
}

async function parentChain(run: Run): Promise<Run[]> {
  const chain: Run[] = [];
  const seen = new Set<string>();
  for (let id = run.parentRunId; id && !seen.has(id); ) {
    seen.add(id);
    const parent = await getRunWithArchived(id);
    if (!parent) break;
    chain.push(parent);
    id = parent.parentRunId;
  }
  return chain;
}

export interface TempScrubOutcome extends TempScrubResult {
  /** Removed task dirs with their run and whether its bundle had them. */
  taskDirs: Array<{ path: string; runId: string | null; bundle: string }>;
  /** Nested Git checkouts deleted, with their kind (clone, linked worktree, bare). */
  checkouts: Array<{ path: string; kind: string }>;
}

/**
 * Prepare's clear-out for a new run: everything in temp/ goes except farm state, the task dirs
 * of this run, its parent chain and runs still bound to the slot. Another live run on the slot
 * stops it, since its scratch cannot be told apart; a queued pin or a run parked off the slot
 * does not. Nested Git checkouts are deleted outright: a run's real work is on its branch and
 * in its bundle.
 */
export async function scrubTempForRun(
  vars: SlotVars,
  projectJson: RawProjectJson,
  run: Run,
): Promise<TempScrubOutcome | null> {
  const taskDirName = resolveProjectTaskDirName(projectJson).replace(/\/+$/, '');
  if (taskDirName !== TEMP_TASK_ROOT) return null;
  const chain = await parentChain(run);
  const chainIds = new Set([run.id, ...chain.map((owner) => owner.id)]);
  const slotRuns = listRunsForSlotHistory(vars.slotId, { limit: 100 }).runs;
  const row = await readSlotRow(vars.slotId);
  const bound = slotRuns.filter(
    (other) => !chainIds.has(other.id) && !isTerminalRunStatus(other.status),
  );
  const live = bound.find(
    (other) => !slotPinIsRequestOnly(other, row) && !isSlotFreedByPark(other),
  );
  if (live)
    throw new Error(
      `Slot ${vars.slotId} still has live run ${live.id.slice(0, 8)}; temp/ cannot be cleared for a new run. Finish, park or release that run, then prepare again.`,
    );
  const keep = [
    ...tempStatePaths(projectJson),
    ...[run, ...chain, ...bound].flatMap((owner) => slotTaskRelDir(owner, taskDirName) ?? []),
  ];
  const keptDir = (dir: string) => keep.some((kept) => dir === kept || dir.startsWith(`${kept}/`));
  const present = (await listTempTaskDirs(vars, taskDirName)).filter((dir) => !keptDir(dir));

  // Named before anything goes, so an unreadable bundle is reported with the dir still there.
  const byDir = new Map(
    slotRuns.flatMap((owner) => {
      const rel = slotTaskRelDir(owner, taskDirName);
      return rel ? [[rel, owner] as const] : [];
    }),
  );
  const named: TempScrubOutcome['taskDirs'] = [];
  for (const dir of present) {
    const owner = byDir.get(dir);
    let bundle = 'no run record';
    if (owner) {
      try {
        const check = await taskBundleCheck(owner);
        bundle = check.confirmed ? 'in its bundle' : `NOT in a bundle (${check.reason})`;
      } catch (error) {
        // Naming only: the dir goes either way, and the reason is shown, not hidden.
        bundle = `bundle unreadable (${(error as Error).message})`;
      }
    }
    named.push({ path: dir, runId: owner?.id ?? null, bundle });
  }

  const result = await scrubSlotTemp(vars, keep, taskDirName);
  // A task dir went only if nothing at, below or above it was refused.
  const taskDirs = named.filter(
    (dir) =>
      !result.refused.some(
        (entry) =>
          entry.path === dir.path ||
          entry.path.startsWith(`${dir.path}/`) ||
          dir.path.startsWith(`${entry.path}/`),
      ),
  );
  const checkouts = result.removed.filter((entry) => isCheckoutKind(entry.kind));
  return { ...result, taskDirs, checkouts };
}

/** A removed entry's kind names a nested Git checkout (`linked worktree (branch … kept)` too). */
function isCheckoutKind(kind: string): boolean {
  return CHECKOUT_KINDS.some((checkout) => kind === checkout || kind.startsWith(`${checkout} (`));
}

/** The prepare output and the run's record name at most this many entries of each list. */
export const TEMP_SCRUB_LISTED = 50;
/** Longest path, kind or reason the record keeps, so one entry can't grow the run without bound. */
const TEMP_SCRUB_TEXT = 300;

function clip(text: string): string {
  return text.length > TEMP_SCRUB_TEXT ? `${text.slice(0, TEMP_SCRUB_TEXT - 1)}…` : text;
}

function reasons(entries: TempScrubReasonEntry[]): TempScrubReasonEntry[] {
  return entries
    .slice(0, TEMP_SCRUB_LISTED)
    .map(({ path, reason }) => ({ path: clip(path), reason: clip(reason) }));
}

/**
 * The bounded record of one clear-out. A task dir that is also a checkout, or sits inside a
 * removed checkout or another removed task dir, is not listed again; nor is anything else under
 * a listed one. A checkout inside a task dir is still listed, as its own deletion.
 */
export function tempScrubReceipt(outcome: TempScrubOutcome): TempScrubReceipt {
  const checkoutPaths = outcome.checkouts.map((entry) => entry.path);
  const within = (entry: string, roots: readonly string[]) =>
    roots.some((root) => entry === root || entry.startsWith(`${root}/`));
  const taskDirPaths = outcome.taskDirs.map((dir) => dir.path);
  const taskDirs = outcome.taskDirs.filter(
    (dir) =>
      !within(dir.path, checkoutPaths) &&
      !taskDirPaths.some((other) => dir.path.startsWith(`${other}/`)),
  );
  const roots = [...checkoutPaths, ...taskDirs.map((dir) => dir.path)];
  const listedAbove = (entry: string) => within(entry, roots);
  const removed: TempScrubRemovedEntry[] = [
    ...outcome.checkouts.map(
      ({ path, kind }): TempScrubRemovedEntry => ({
        type: 'checkout',
        path: clip(path),
        kind: clip(kind),
      }),
    ),
    ...taskDirs.map(
      (dir): TempScrubRemovedEntry => ({
        type: 'task-dir',
        path: clip(dir.path),
        run: dir.runId,
        bundle: clip(dir.bundle),
      }),
    ),
    ...outcome.removed
      .filter((entry) => !listedAbove(entry.path))
      .map(
        ({ path, kind }): TempScrubRemovedEntry => ({
          type: 'entry',
          path: clip(path),
          kind: clip(kind),
        }),
      ),
  ];
  return {
    removed: removed.slice(0, TEMP_SCRUB_LISTED),
    removedCount: removed.length,
    kept: reasons(outcome.kept),
    keptCount: outcome.kept.length,
    refused: reasons(outcome.refused),
    refusedCount: outcome.refused.length,
  };
}

function removedLine(entry: TempScrubRemovedEntry): string {
  switch (entry.type) {
    case 'checkout':
      return `Deleted nested ${entry.kind} ${entry.path}`;
    case 'task-dir':
      return `Removed earlier task dir ${entry.path} (${entry.run ? `run ${entry.run.slice(0, 8)}, ${entry.bundle}` : entry.bundle})`;
    case 'entry':
      return `Removed ${entry.kind} ${entry.path}`;
  }
}

/** One prepare output line per listed entry, then a count of any the cap left out. */
export function tempScrubLines(receipt: TempScrubReceipt): string[] {
  const unlisted = (count: number, listed: number, what: string) => {
    const rest = count - listed;
    return rest > 0
      ? [`${rest} more ${what} temp/ entr${rest === 1 ? 'y' : 'ies'} not listed`]
      : [];
  };
  return [
    ...receipt.removed.map(removedLine),
    ...unlisted(receipt.removedCount, receipt.removed.length, 'removed'),
    ...receipt.kept.map((entry) => `Left ${entry.path}: ${entry.reason}`),
    ...unlisted(receipt.keptCount, receipt.kept.length, 'kept'),
  ];
}

/**
 * The one prepare step the clear-out reports (its lines go out as one output chunk), or null
 * when it found nothing to remove, keep or refuse.
 */
export function tempScrubSummary(receipt: TempScrubReceipt): string | null {
  const { removedCount, keptCount, refusedCount } = receipt;
  if (removedCount + keptCount + refusedCount === 0) return null;
  const plural = (count: number) => `${count} entr${count === 1 ? 'y' : 'ies'}`;
  const done = `removed ${plural(removedCount)}, kept ${plural(keptCount)}`;
  return refusedCount > 0
    ? `temp/ clear-out refused ${plural(refusedCount)}; ${done}`
    : `Cleared temp/ for this run: ${done}`;
}
