/**
 * Presentation of checklist progress for the mobile panels: the step-row colour
 * both levels share, plus the child checklist unit header (ADR-060). The
 * projection itself comes from the gateway — this only decides labels, colours,
 * and whether a child's steps list starts collapsed.
 */
import { isSettledSubtaskStatus, type TaskStepSubtaskProgress } from '@farmslot/protocol';
// The shared palette, not `./theme`: that module builds StyleSheets, which pulls
// react-native into this pure module and out of reach of the node test runner.
import { colors } from '@farmslot/theme';

const SUBTASK_STATUS_LABELS: Record<string, string> = {
  running: 'running',
  stale: 'stale',
  blocked: 'blocked',
  complete: 'complete',
  done: 'done',
  failed: 'failed',
};

export interface SubtaskProgressView {
  /** Source ref basename, or `inline` for a unit registered from command-line text. */
  title: string;
  statusLabel: string;
  color: string;
  counts: string;
  currentStep: string | null;
  /** Shown instead of a tooltip: a stale unit names the last child mark. */
  staleNote: string | null;
  settled: boolean;
}

/** Step-row colour, used for parent rows and for a child unit's own rows. */
export function taskStepStatusColor(status: string): string {
  if (status === 'done') return colors.statusOk;
  if (status === 'running') return colors.statusWarn;
  if (status === 'skipped') return colors.textMuted;
  return colors.accent;
}

export function subtaskStatusColor(status: string): string {
  if (status === 'complete' || status === 'done') return colors.statusOk;
  if (status === 'blocked' || status === 'failed') return colors.statusFail;
  if (status === 'stale') return colors.statusWarn;
  return colors.accent;
}

export function subtaskProgressView(subtask: TaskStepSubtaskProgress): SubtaskProgressView {
  const ref = subtask.source.ref?.trim();
  return {
    title: ref ? ref.split('/').pop() || ref : 'inline',
    statusLabel: SUBTASK_STATUS_LABELS[subtask.status] ?? subtask.status,
    color: subtaskStatusColor(subtask.status),
    counts: `${subtask.progress.completedSteps}/${subtask.progress.totalSteps}`,
    currentStep: subtask.progress.currentStep,
    staleNote:
      subtask.status === 'stale'
        ? `no mark since ${subtask.lastEventAt ?? 'the unit started'}`
        : null,
    settled: isSettledSubtaskStatus(subtask.status),
  };
}
