// When the current task identity began executing. QA evidence must not predate it,
// and a dispatch replay that resumes the same task keeps it.
import path from 'node:path';

import { primaryRoleForFlow, type Run, type RunTaskExecution } from '@farmslot/protocol';

type TaskRun = Pick<Run, 'flowType' | 'taskFile' | 'steps' | 'engineState' | 'agentContexts'>;

const stepStartedAt = (run: TaskRun, name: string) =>
  run.steps.find((step) => step.name === name)?.startedAt;

/** `<flow>/<task folder>`: the same on the gateway, the slot and a mirror import. */
function sameTask(a: string | null | undefined, b: string | null | undefined): boolean {
  const identity = (taskFile: string) =>
    path.join(
      path.basename(path.dirname(path.dirname(taskFile))),
      path.basename(path.dirname(taskFile)),
    );
  return Boolean(a && b && identity(a) === identity(b));
}

/**
 * For runs dispatched before the anchor existed: the primary worker's first launch,
 * but only after the current task was written (a write-task replay keeps the context
 * and writes a new task) and no later than the current dispatch.
 */
function launchOnCurrentTask(run: TaskRun): string | undefined {
  const primary = run.agentContexts?.find(
    (context) => context.role === primaryRoleForFlow(run.flowType),
  );
  const launchedAt = primary?.startedAt;
  if (!launchedAt || !sameTask(primary.taskFile, run.taskFile)) return undefined;
  const launched = Date.parse(launchedAt);
  // NaN from a missing or unparseable time compares false.
  return Date.parse(stepStartedAt(run, 'write-task') ?? '') <= launched &&
    launched <= Date.parse(stepStartedAt(run, 'dispatch') ?? '')
    ? launchedAt
    : undefined;
}

/** The anchor a starting dispatch records, or null when it resumes the anchored task. */
export function taskExecutionAtDispatch(run: TaskRun): RunTaskExecution | null {
  const dispatchedAt = stepStartedAt(run, 'dispatch');
  if (!run.taskFile || !dispatchedAt) return null;
  if (sameTask(run.engineState?.taskExecution?.taskFile, run.taskFile)) return null;
  return { taskFile: run.taskFile, startedAt: launchOnCurrentTask(run) ?? dispatchedAt };
}

/** The earliest time QA recipe evidence for the current task may start. */
export function qaEvidenceStartedAt(run: TaskRun & Pick<Run, 'startedAt' | 'createdAt'>): string {
  const anchor = run.engineState?.taskExecution;
  if (anchor && sameTask(anchor.taskFile, run.taskFile)) return anchor.startedAt;
  return (
    (anchor ? undefined : launchOnCurrentTask(run)) ??
    stepStartedAt(run, 'dispatch') ??
    run.startedAt ??
    run.createdAt
  );
}
