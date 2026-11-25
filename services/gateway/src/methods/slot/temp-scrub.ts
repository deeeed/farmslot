import { existsSync } from 'node:fs';
import path from 'node:path';

import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

import { resolveProjectRuntimeDirName, resolveProjectTaskDirName } from '../../core/config.js';
import type { RawProjectJson, SlotVars } from '../../core/index.js';
import { retainTaskCheckouts } from '../../fleet/slot-scaffolding.js';
import { scrubSlotTemp, type TempScrubResult } from '../../fleet/temp-scrub.js';
import { retainedRunTaskDirectory } from '../../run-completion/retained-artifacts.js';
import { workerTaskDirectory } from '../../run-engine/worker-task-dir.js';
import { getRunWithArchived, listRunsForSlotHistory } from '../../runs/store.js';

/** The layout this scrub owns: only there is everything in temp/ a run's or the farm's. */
export const TEMP_TASK_ROOT = 'temp/tasks';

/** Farm and recipe state a slot keeps between runs; everything else in temp/ is a run's. */
export function tempStatePaths(projectJson: RawProjectJson): string[] {
  const runtime = resolveProjectRuntimeDirName(projectJson);
  return [
    'temp/farmslot',
    ...(runtime.startsWith('temp/') ? [runtime] : []),
    'temp/recipe/harness',
    'temp/.agent/preflight.pid',
  ];
}

/** A run's task dir on the slot, relative to the checkout (the worker keeps flow and folder). */
export function slotTaskRelDir(run: Pick<Run, 'taskFile'>, taskDirName: string): string | null {
  return run.taskFile ? workerTaskDirectory(run.taskFile, '', taskDirName).replace(/^\/+/, '') : null;
}

/**
 * The run's own output is in its final bundle: the final ref, a complete capture, and the
 * bundle's copy of the task dir holding TASK.md and every recorded artifact.
 */
export async function taskBundleConfirmed(run: Run): Promise<boolean> {
  const ref = run.output?.artifactBundle;
  if (
    !isTerminalRunStatus(run.status) ||
    !ref ||
    run.output?.captureError ||
    run.output?.retentionMissingData?.length
  )
    return false;
  let taskDir: string;
  try {
    taskDir = await retainedRunTaskDirectory(run, ref);
  } catch {
    // An unreadable or foreign bundle is not a confirmation; the slot copy stays.
    return false;
  }
  return (
    existsSync(path.join(taskDir, 'TASK.md')) &&
    run.output!.artifactManifest.every((artifact) => existsSync(path.join(taskDir, artifact.path)))
  );
}

/** A new run's prepare clears temp/; a warm handoff, a replay or a resumed task keeps it. */
export function shouldScrubTempForRun(
  run: Pick<Run, 'engineState' | 'steps'> | undefined,
): run is Run {
  return Boolean(
    run &&
      !run.engineState?.flags?.warmSessionReuse &&
      run.engineState?.taskInit?.status !== 'initialized' &&
      !run.steps.some((entry) => entry.name === 'dispatch' && entry.status === 'done'),
  );
}

async function parentChain(run: Run | undefined): Promise<Run[]> {
  const chain: Run[] = [];
  const seen = new Set<string>();
  for (let id = run?.parentRunId; id && !seen.has(id); ) {
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
  taskDirs: Array<{ path: string; runId: string | null; bundled: boolean }>;
}

/**
 * Clear the slot's temp/ for `run`: keep farm state, the run's own task dir, its parent
 * chain's, and every live run's on this slot. Nested checkouts in a task dir go through the
 * usual retention first. Returns what stays refused; the caller decides how loud that is.
 */
export async function scrubTempForRun(
  vars: SlotVars,
  projectJson: RawProjectJson,
  run: Run | undefined,
  options: { keepOwn: boolean },
): Promise<TempScrubOutcome | null> {
  const taskDirName = resolveProjectTaskDirName(projectJson);
  if (taskDirName !== TEMP_TASK_ROOT) return null;
  const slotRuns = listRunsForSlotHistory(vars.slotId, { limit: 100 }).runs;
  const keepRuns = [
    ...(options.keepOwn && run ? [run] : []),
    ...(await parentChain(run)),
    ...slotRuns.filter((other) => other.id !== run?.id && !isTerminalRunStatus(other.status)),
  ];
  const keep = [
    ...tempStatePaths(projectJson),
    ...keepRuns.flatMap((owner) => slotTaskRelDir(owner, taskDirName) ?? []),
  ];
  let result = await scrubSlotTemp(vars, keep);
  const taskRoot = `${vars.remoteRepo.replace(/\/+$/, '')}/${taskDirName}/`;
  const checkoutDirs = result.refused
    .filter(({ path: p, reason }) => reason.includes('nested Git checkout') && p.startsWith(taskRoot))
    .map(({ path: p }) => p.slice(taskRoot.length))
    .filter((rel) => rel.split('/').length === 2);
  if (checkoutDirs.length) {
    for (const rel of checkoutDirs) await retainTaskCheckouts(vars, projectJson, rel);
    const again = await scrubSlotTemp(vars, keep);
    result = { removed: [...result.removed, ...again.removed], refused: again.refused };
  }
  const byDir = new Map(
    slotRuns.flatMap((owner) => {
      const rel = slotTaskRelDir(owner, taskDirName);
      return rel ? [[rel, owner] as const] : [];
    }),
  );
  const taskDirs: TempScrubOutcome['taskDirs'] = [];
  for (const { path: removed } of result.removed) {
    if (!removed.startsWith(taskRoot)) continue;
    const rel = removed.slice(vars.remoteRepo.replace(/\/+$/, '').length + 1);
    if (rel.split('/').length !== 4) continue;
    const owner = byDir.get(rel);
    taskDirs.push({
      path: removed,
      runId: owner?.id ?? null,
      bundled: owner ? await taskBundleConfirmed(owner) : false,
    });
  }
  return { ...result, taskDirs };
}
