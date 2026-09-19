// Child checklist unit cost roll-up (ADR-060). Read once at monitor completion
// and persisted on `run.metrics.subtasks` so a pruned task directory still
// carries each child's step count and duration, exactly as `checklistTiming`
// already survives for the parent.

import path from 'node:path';

import {
  DEFAULT_TASK_DIR,
  enumerateChecklistCheckboxes,
  type Run,
  type RunSubtaskMetrics,
  type WorkerSignalChecklistTiming,
} from '@farmslot/protocol';

import {
  getOrchestratorTaskRoot,
  loadProjectVars,
  loadSlotVars,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
} from '../core/config.js';

import { readSubtaskIndex, readSubtaskUnits } from './subtasks.js';

/** First to last mark of one child, or null when it never marked a step. */
export function subtaskDurationMs(
  timing: WorkerSignalChecklistTiming | null | undefined,
): number | null {
  const stamps = (timing?.events ?? [])
    .map((event) => Date.parse(event.checkedAt))
    .filter((value) => Number.isFinite(value));
  if (stamps.length === 0) return null;
  return Math.max(0, Math.max(...stamps) - Math.min(...stamps));
}

/**
 * The worker's copy of a run's task directory, where `mark` writes `subtasks/`.
 * The orchestrator copy holds only the `.worker` mirror, which lands after
 * completion, so the live registry is read from the slot.
 */
export async function resolveWorkerTaskDirForRun(
  run: Pick<Run, 'project' | 'taskFile'>,
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): Promise<string | null> {
  if (!run.taskFile) return null;
  const projectVars = await loadProjectVars(run.project).catch(() => null);
  const taskDirName = projectVars
    ? resolveProjectTaskDirName(projectVars.projectJson)
    : DEFAULT_TASK_DIR;
  const orchestratorRoot = getOrchestratorTaskRoot(run.project, projectVars?.projectJson ?? null);
  const taskRelDir = resolveTaskRelDir(run.taskFile, orchestratorRoot);
  if (taskRelDir === null) return null;
  return path.join(vars.remoteRepo, taskDirName, taskRelDir);
}

/**
 * One entry per registered child unit, or null when the run registered none.
 *
 * Every unit in the registry is reported, whatever parent checklist it hangs off
 * — a self-review child costs the run the same as a worker-checklist child, and
 * the `parent` field says which is which. `status` is the child's own signal
 * status; the gateway's `stale` projection is a live read, not a recorded fact,
 * so it never lands here.
 */
export async function collectRunSubtaskMetrics(
  run: Pick<Run, 'project' | 'taskFile'>,
  slotId: string,
): Promise<RunSubtaskMetrics[] | null> {
  const vars = await loadSlotVars(slotId);
  const workerTaskDir = await resolveWorkerTaskDirForRun(run, vars);
  if (!workerTaskDir) return null;
  const index = await readSubtaskIndex(vars, workerTaskDir);
  if (!index || index.units.length === 0) return null;

  const metrics: RunSubtaskMetrics[] = [];
  for (const read of await readSubtaskUnits(vars, workerTaskDir, index.units)) {
    const items = enumerateChecklistCheckboxes(read.markdown);
    const timing = read.signal?.checklistTiming;
    metrics.push({
      id: read.unit.id,
      parent: read.unit.parent,
      source: read.unit.source,
      status: read.signal?.status ?? null,
      durationMs: subtaskDurationMs(timing),
      completedSteps: items.filter((item) => item.checked).length,
      totalSteps: items.length,
      ...(timing ? { checklistTiming: timing } : {}),
    });
  }
  return metrics.length > 0 ? metrics : null;
}
