import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

import { resolveProjectRuntimeDirName, resolveProjectTaskDirName } from '../../core/config.js';
import { execOnSlot, type RawProjectJson, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { scrubSlotTemp, type TempScrubResult } from '../../fleet/temp-scrub.js';
import { retainedRunTaskDirectory } from '../../run-completion/retained-artifacts.js';
import { workerTaskDirectory } from '../../run-engine/worker-task-dir.js';
import { getRunWithArchived, listRunsForSlotHistory } from '../../runs/store.js';

/** The layout this scrub owns: only there is everything in temp/ a run's or the farm's. */
export const TEMP_TASK_ROOT = 'temp/tasks';

/**
 * What a slot keeps in temp/ between runs: the runtime dir, the recipe harness, the dirs of the
 * project's watched resource files (dev server and browser pid files and their profiles), the
 * preflight pid and Spotlight's opt-out. Their content is farm state, not a run's output.
 */
export function tempStatePaths(projectJson: RawProjectJson): string[] {
  const runtime = resolveProjectRuntimeDirName(projectJson);
  const watched = Object.values(projectJson.resources ?? {}).flatMap((resource) => {
    const watchPath = resource.watch?.path?.replaceAll('{{runtime_dir}}', runtime);
    return watchPath ? [path.posix.dirname(path.posix.normalize(watchPath))] : [];
  });
  return [
    ...new Set(
      [
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

export type BundleCheck = { confirmed: true; taskDir: string } | { confirmed: false; reason: string };

/**
 * The run's final bundle holds this task: the final ref, a complete capture, a bundle record
 * naming the run's task folder, and `TASK.md` plus every recorded artifact in its copy.
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
  const recorded: unknown = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : null;
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
  if (typeof taskPath !== 'string' || !taskPath.endsWith(folder))
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

/**
 * Release drops the run's own task dir only once every file in it is in the confirmed bundle:
 * files written after capture would be lost otherwise.
 */
export async function ownTaskDirInBundle(
  vars: SlotVars,
  run: Run,
  slotTaskDir: string,
): Promise<BundleCheck> {
  const check = await taskBundleCheck(run);
  if (!check.confirmed) return check;
  const listed = await execOnSlot(
    vars,
    `cd ${shellQuote(slotTaskDir)} 2>/dev/null && find . -type f -print`,
    { timeout: 30_000 },
  );
  if (listed.exitCode !== 0) return { confirmed: false, reason: 'task dir unreadable' };
  const notCaptured = listed.stdout
    .split('\n')
    .map((line) => line.replace(/^\.\//, ''))
    .find((rel) => rel && !existsSync(path.join(check.taskDir, rel)));
  return notCaptured
    ? { confirmed: false, reason: `${notCaptured} is not in the bundle` }
    : check;
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
}

/**
 * Prepare's clear-out for a new run: everything in temp/ goes except farm state, the run's own
 * task dir and its parent chain's. Another live run on the slot stops it: its scratch cannot be
 * told apart. Nested checkouts are moved out of the checkout, never deleted.
 */
export async function scrubTempForRun(
  vars: SlotVars,
  projectJson: RawProjectJson,
  run: Run,
): Promise<TempScrubOutcome | null> {
  const taskDirName = resolveProjectTaskDirName(projectJson);
  if (taskDirName !== TEMP_TASK_ROOT) return null;
  const chain = await parentChain(run);
  const chainIds = new Set([run.id, ...chain.map((owner) => owner.id)]);
  const slotRuns = listRunsForSlotHistory(vars.slotId, { limit: 100 }).runs;
  const live = slotRuns.find(
    (other) => !chainIds.has(other.id) && !isTerminalRunStatus(other.status),
  );
  if (live)
    throw new Error(
      `Slot ${vars.slotId} still has live run ${live.id.slice(0, 8)}; temp/ cannot be cleared for a new run`,
    );
  const keep = [
    ...tempStatePaths(projectJson),
    ...[run, ...chain].flatMap((owner) => slotTaskRelDir(owner, taskDirName) ?? []),
  ];
  const result = await scrubSlotTemp(vars, keep, taskDirName);
  const byDir = new Map(
    slotRuns.flatMap((owner) => {
      const rel = slotTaskRelDir(owner, taskDirName);
      return rel ? [[rel, owner] as const] : [];
    }),
  );
  const taskDirs: TempScrubOutcome['taskDirs'] = [];
  for (const { path: removed } of result.removed) {
    if (!removed.startsWith(`${taskDirName}/`) || removed.split('/').length !== 4) continue;
    const owner = byDir.get(removed);
    let bundle = 'no run record';
    if (owner) {
      try {
        const check = await taskBundleCheck(owner);
        bundle = check.confirmed ? 'in its bundle' : `NOT in a bundle (${check.reason})`;
      } catch (error) {
        // Naming only: the dir is already gone; the reason is shown, not hidden.
        bundle = `bundle unreadable (${(error as Error).message})`;
      }
    }
    taskDirs.push({ path: removed, runId: owner?.id ?? null, bundle });
  }
  return { ...result, taskDirs };
}
