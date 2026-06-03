import type {
  Run,
  SlotStatus,
  TaskProgressStructured,
  TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

type UnknownRecord = Record<string, unknown>;

export interface TaskProgressFallbackSummary {
  title: string;
  meta: string;
  percent: number | null;
}

function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function ciWatchOutputsForRun(run: Run | null | undefined): Record<string, unknown> {
  const step = run?.steps.find((candidate) => candidate.name === 'ci-watch');
  return step?.outputs ?? {};
}

export function isInlineCiFixActiveFromOutputs(out: Record<string, unknown>): boolean {
  return (
    out.fixInProgress === true && (out.phase === 'fixing' || out.phase === 'waiting_for_worker')
  );
}

export function buildCiFixTaskProgress(
  run: Run | null | undefined,
): TaskProgressStructured | undefined {
  const progress = recordValue(ciWatchOutputsForRun(run).fixProgress);
  const total = numberValue(progress?.total);
  if (!total) return undefined;
  const completed = numberValue(progress?.completed) ?? 0;
  const currentLabel = typeof progress?.currentLabel === 'string' ? progress.currentLabel : null;
  const steps = Array.from({ length: total }, (_, index) => {
    const oneBased = index + 1;
    return {
      index: oneBased,
      name: oneBased === completed + 1 && currentLabel ? currentLabel : `Step ${oneBased}`,
      status:
        oneBased <= completed
          ? ('done' as const)
          : oneBased === completed + 1
            ? ('running' as const)
            : ('pending' as const),
    };
  });
  return {
    schema: {
      flowType: 'ci-watch',
      title: 'CI fix',
      totalSteps: total,
      phases: [{ name: 'CI fix', steps: steps.map(({ index, name }) => ({ index, name })) }],
    },
    phases: [{ name: 'CI fix', steps, completedSteps: completed, totalSteps: total }],
    completedSteps: completed,
    totalSteps: total,
    currentPhase: 'CI fix',
    currentStep: currentLabel,
  };
}

export function effectiveTaskProgressForRun(
  run: Run | null | undefined,
  taskProgress: TaskProgressStructured | null | undefined,
): TaskProgressStructured | undefined {
  return taskProgress ?? buildCiFixTaskProgress(run);
}

export function activeTaskProgressStepId(
  run: Run | null | undefined,
  taskProgress: TaskProgressStructured | null | undefined,
): 'monitor' | 'self-review' | 'ci-watch' | null {
  const progress = effectiveTaskProgressForRun(run, taskProgress);
  if (!progress?.totalSteps) return null;
  if (isSelfReviewProgressActive(run)) return 'self-review';
  if (isInlineCiFixActiveFromOutputs(ciWatchOutputsForRun(run))) return 'ci-watch';
  const monitorStep = run?.steps.find((step) => step.name === 'monitor');
  if (monitorStep?.status === 'running') return 'monitor';
  return null;
}

export function isWorkerProgressActive(run: Run | null | undefined): boolean {
  if (!run?.slotId) return false;
  if (
    run.status === 'monitoring' ||
    run.status === 'paused' ||
    run.status === 'self-reviewing' ||
    run.status === 'ci-watching' ||
    run.status === 'completing'
  ) {
    return true;
  }
  if (run.activeTaskFile && run.activeTaskFile !== run.taskFile) return true;
  return run.steps.some(
    (step) =>
      (step.name === 'monitor' || step.name === 'self-review' || step.name === 'ci-watch') &&
      step.status === 'running',
  );
}

export function isSlotWorkerProgressActive(
  slot:
    | Pick<SlotStatus, 'lifecycle' | 'phase' | 'taskPhase' | 'taskStepProgress' | 'activeTaskFile'>
    | null
    | undefined,
): boolean {
  if (!slot) return false;
  if (slot.lifecycle === 'busy') return true;
  if (slot.phase === 'working' || slot.phase === 'review-gate' || slot.phase === 'ci-watch') {
    return true;
  }
  if (slot.activeTaskFile) return true;
  if (slot.taskPhase) return true;
  return typeof slot.taskStepProgress === 'number' && slot.taskStepProgress > 0;
}

export function shouldAcceptTaskProgressUpdate(
  run: Run | null | undefined,
  update: TaskProgressUpdatedPayload,
): boolean {
  if (!run?.slotId || update.slotId !== run.slotId || update.runId !== run.id) return false;
  const activeTaskFile = run.activeTaskFile;
  if (!activeTaskFile || activeTaskFile === run.taskFile) return true;
  const activeName = activeTaskFile.split('/').pop();
  if (activeName === 'SELF-REVIEW.md') {
    return update.contextId === 'self-review' || update.role === 'self-review';
  }
  return true;
}

export function taskProgressPercent(progress: TaskProgressStructured): number {
  if (!progress.totalSteps) return 0;
  return Math.max(0, Math.min(100, (progress.completedSteps / progress.totalSteps) * 100));
}

export function taskProgressTitle(
  run: Run | null | undefined,
  progress: TaskProgressStructured | null | undefined,
): string {
  const activeStep = activeTaskProgressStepId(run, progress);
  if (activeStep === 'self-review') return 'Self-review progress';
  if (activeStep === 'ci-watch') return 'CI fix progress';
  return 'Worker progress';
}

export function fallbackTaskProgressSummary(
  run: Run | null | undefined,
  slot?:
    | Pick<SlotStatus, 'phase' | 'taskPhase' | 'taskStepProgress' | 'activeTaskFile'>
    | null
    | undefined,
): TaskProgressFallbackSummary {
  const runningStep = run?.steps.find((step) => step.status === 'running');
  const activeTaskFile = slot?.activeTaskFile ?? run?.activeTaskFile;
  const activeTaskName = activeTaskFile?.split('/').pop();
  const title =
    activeTaskName?.startsWith('SELF-REVIEW') || run?.status === 'self-reviewing'
      ? 'Self-review progress'
      : taskProgressTitle(run, undefined);
  const meta =
    slot?.taskPhase ??
    runningStep?.detail ??
    runningStep?.name ??
    activeTaskName ??
    run?.status ??
    slot?.phase ??
    'Waiting for checklist data';
  const rawPercent =
    typeof slot?.taskStepProgress === 'number' && Number.isFinite(slot.taskStepProgress)
      ? slot.taskStepProgress
      : null;

  return {
    title,
    meta,
    percent: rawPercent == null ? null : Math.max(0, Math.min(100, rawPercent * 100)),
  };
}

function isSelfReviewProgressActive(run: Run | null | undefined): boolean {
  const selfReviewStep = run?.steps.find((step) => step.name === 'self-review');
  if (!selfReviewStep) return false;
  return (
    selfReviewStep.status === 'running' ||
    run?.status === 'self-reviewing' ||
    run?.activeTaskFile?.split('/').pop() === 'SELF-REVIEW.md'
  );
}
