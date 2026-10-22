import {
  enumerateChecklistCheckboxes,
  type Run,
  type TaskProgressStructured,
  type TaskStepProgress,
} from '@farmslot/protocol';
import {
  nestedLoopProgressLabel,
  type PipelineProgressStep,
} from '@farmslot/protocol/checklist-target';

export interface ChecklistProgressStep {
  text: string;
  checked: boolean;
}

export interface ChecklistProgressFallback {
  title: string;
  meta: string;
  percent: number | null;
}

export interface ChecklistRowView {
  step: TaskStepProgress;
  icon: string;
}

export interface ChecklistPhaseView {
  name: string;
  counts: string;
  complete: boolean;
  running: boolean;
  rows: ChecklistRowView[];
}

export interface ChecklistProgressView {
  title: string;
  counts: string | null;
  heading: string;
  completedSteps: number;
  totalSteps: number;
  currentPhase: string | null;
  percent: number | null;
  phases: ChecklistPhaseView[];
  waiting: boolean;
  message: string | null;
}

export interface ChecklistProgressOptions {
  activeStep?: PipelineProgressStep;
  activeTaskBasename?: string | null;
  markdown?: string;
  steps?: readonly ChecklistProgressStep[];
  fallback?: ChecklistProgressFallback | null;
}

export function checklistProgressRow(step: TaskStepProgress): ChecklistRowView {
  return {
    step,
    icon:
      step.status === 'done'
        ? 'v'
        : step.status === 'running'
          ? '*'
          : step.status === 'skipped'
            ? '-'
            : '.',
  };
}

export function taskProgressPercent(
  progress: Pick<TaskProgressStructured, 'completedSteps' | 'totalSteps'>,
): number {
  return progress.totalSteps
    ? Math.max(0, Math.min(100, (progress.completedSteps / progress.totalSteps) * 100))
    : 0;
}

/** One read-only presentation of engine progress and its existing markdown fallback. */
export function checklistProgressView(
  progress: TaskProgressStructured | null | undefined,
  options: ChecklistProgressOptions = {},
): ChecklistProgressView | null {
  const title = nestedLoopProgressLabel(options.activeStep ?? null, options.activeTaskBasename);
  const flat = progress
    ? []
    : (options.steps ??
      enumerateChecklistCheckboxes(options.markdown ?? '').map((row) => ({
        text: row.rawLabel,
        checked: row.checked,
      })));
  const total = progress?.totalSteps ?? flat.length;
  const completed = progress?.completedSteps ?? flat.filter((row) => row.checked).length;
  if (!total && !options.fallback) return null;
  const phases =
    progress?.phases ??
    (flat.length
      ? [
          {
            name: 'Checklist',
            completedSteps: completed,
            totalSteps: total,
            steps: flat.map(
              (row, index): TaskStepProgress => ({
                index: index + 1,
                name: row.text,
                status: row.checked ? 'done' : 'pending',
              }),
            ),
          },
        ]
      : []);
  const displayTitle = total ? title : (options.fallback?.title ?? title);
  const percent = total
    ? taskProgressPercent({ completedSteps: completed, totalSteps: total })
    : (options.fallback?.percent ?? null);
  const counts = total ? `${completed}/${total}` : null;
  const currentPhase = progress?.currentPhase ?? null;
  return {
    title: displayTitle,
    heading: `${displayTitle}${counts ? ` ${counts}` : percent !== null ? ` ${Math.round(percent)}%` : ''}${currentPhase ? ` · ${currentPhase}` : ''}`,
    completedSteps: completed,
    totalSteps: total,
    counts: total ? `${completed}/${total}` : null,
    currentPhase: progress?.currentPhase ?? null,
    percent,
    phases: phases.map((phase) => ({
      name: phase.name,
      counts: `${phase.completedSteps}/${phase.totalSteps}`,
      complete: phase.completedSteps === phase.totalSteps,
      running: phase.steps.some((step) => step.status === 'running'),
      rows: phase.steps.map(checklistProgressRow),
    })),
    waiting: total === 0,
    message: total ? null : (options.fallback?.meta ?? null),
  };
}

export interface ChecklistProgressRead {
  key: string;
  revision: number;
}

/** Admit only the current read, without letting a delayed response replace a live update. */
export class ChecklistProgressReads {
  private key: string | null = null;
  private revision = 0;

  select(key: string | null): void {
    if (this.key !== key) {
      this.key = key;
      this.invalidate();
    }
  }

  begin(key: string): ChecklistProgressRead {
    return { key, revision: ++this.revision };
  }

  invalidate(): void {
    this.revision += 1;
  }

  isCurrent(read: ChecklistProgressRead): boolean {
    return read.key === this.key && read.revision === this.revision;
  }
}

/** The existing CI-fix projection, shared by both pipeline sizes and both clients. */
export function ciFixTaskProgress(
  outputs: Record<string, unknown>,
): TaskProgressStructured | undefined {
  const fix = outputs.fixProgress;
  if (
    !fix ||
    typeof fix !== 'object' ||
    !('total' in fix) ||
    typeof fix.total !== 'number' ||
    !Number.isFinite(fix.total) ||
    !fix.total
  )
    return undefined;
  const total = fix.total;
  const completed =
    'completed' in fix && typeof fix.completed === 'number' && Number.isFinite(fix.completed)
      ? fix.completed
      : 0;
  const label =
    'currentLabel' in fix && typeof fix.currentLabel === 'string' ? fix.currentLabel : null;
  const steps = Array.from(
    { length: total },
    (_, index): TaskStepProgress => ({
      index: index + 1,
      name: index === completed && label ? label : `Step ${index + 1}`,
      status: index < completed ? 'done' : index === completed ? 'running' : 'pending',
    }),
  );
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
    currentStep: label,
  };
}

export function effectiveTaskProgressForRun(
  run: Pick<Run, 'steps'> | null | undefined,
  taskProgress: TaskProgressStructured | null | undefined,
): TaskProgressStructured | undefined {
  return (
    taskProgress ??
    ciFixTaskProgress(run?.steps.find((step) => step.name === 'ci-watch')?.outputs ?? {})
  );
}
