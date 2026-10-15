import {
  enumerateChecklistCheckboxes,
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
