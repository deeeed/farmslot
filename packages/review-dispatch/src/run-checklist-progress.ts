import {
  isTerminalRunStatus,
  type Run,
  shouldAcceptTaskProgressUpdate,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import { ciFixTaskProgress, taskProgressPercent } from './checklist-progress.js';
import { runActivityView, runReviewActivityContext } from './run-activity.js';

export interface RunChecklistProgressTarget {
  key: string;
  params: { slotId: string; runId: string };
}

/** Checklist identity changes with the actor/attempt, even when the run id does not. */
export function runChecklistProgressTarget(run: Run): RunChecklistProgressTarget | null {
  if (isTerminalRunStatus(run.status) || run.waitingForOperator) return null;
  if (!run.slotId && !run.reviewWorkspace) return null;
  const activity = runActivityView(run);
  const step = activity?.step ?? run.steps.find((entry) => entry.status === 'running');
  const owner = activity?.ownerStepName ?? step?.name;
  if (!owner || !['monitor', 'review', 'human-gate', 'ci-watch'].includes(owner)) return null;
  // An idle person gate keeps the last review checklist, but has no current checklist work.
  if (owner === 'human-gate' && (!activity || activity.kind === 'step')) return null;
  const actor = runReviewActivityContext(run);
  return {
    key: JSON.stringify([
      run.id,
      run.slotId ?? run.reviewWorkspace?.workspaceId,
      run.activeTaskFile ?? run.taskFile,
      actor?.id,
      actor?.attemptStartedAt,
      step?.startedAt,
    ]),
    params: { slotId: run.slotId ?? '', runId: run.id },
  };
}

export function acceptsRunChecklistProgress(run: Run, update: TaskProgressUpdatedPayload): boolean {
  const target = runChecklistProgressTarget(run);
  const activity = runActivityView(run);
  const role =
    activity?.kind === 'review' ? 'review' : activity?.kind === 'worker-fix' ? 'review-fix' : null;
  if (role && update.role && update.role !== 'subtask' && update.role !== role) return false;
  return Boolean(
    target &&
    update.runId === target.params.runId &&
    update.slotId === target.params.slotId &&
    shouldAcceptTaskProgressUpdate(run, update),
  );
}

export interface RunChecklistProgressView {
  completed: number;
  total: number;
  counts: string;
  label: string;
  percent: number;
  accessibleLabel: string;
}

/** Both clients render the gateway's checklist counts without inferring totals from hint text. */
export function runChecklistProgressView(
  run: Run,
  progress: TaskProgressStructured | null | undefined,
): RunChecklistProgressView | null {
  if (!runChecklistProgressTarget(run)) return null;
  const ci = run.steps.find(
    (step) => step.name === 'ci-watch' && step.status === 'running',
  )?.outputs;
  const effective = progress ?? (ci?.fixInProgress === true ? ciFixTaskProgress(ci) : undefined);
  const completed = effective?.completedSteps;
  const total = effective?.totalSteps;
  let label = effective?.currentStep;
  if (!total || completed === undefined) return null;
  const current = effective?.phases
    .flatMap((phase) => phase.steps)
    .find((step) => step.status === 'running');
  label =
    label?.trim() || current?.name || (completed === total ? 'Checklist complete' : 'Checklist');
  const counts = `${completed}/${total}`;
  return {
    completed,
    total,
    counts,
    label,
    percent: taskProgressPercent({ completedSteps: completed, totalSteps: total }),
    accessibleLabel: `${counts} checklist steps done · ${label}`,
  };
}
