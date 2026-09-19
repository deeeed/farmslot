/**
 * Presentation of checklist progress for the mobile panels: the step-row colour
 * both levels share, plus the child checklist unit header (ADR-060). The
 * projection itself comes from the gateway — this only decides labels, colours,
 * and whether a child's steps list starts collapsed.
 */
import {
  acceptanceCriteriaView,
  type AcceptanceCriterionRef,
  type AcceptanceCriterionView,
  type AcceptanceStatusLedger,
  isSettledSubtaskStatus,
  summarizeAcceptanceStatus,
  type TaskStepSubtaskProgress,
} from '@farmslot/protocol';
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

/** Verdict colour, matching the run-detail pill: blocking verdicts read as failures. */
export function acceptanceVerdictColor(verdict: string | null): string {
  // No verdict yet is neutral: the panel must not imply one.
  if (verdict === null) return colors.textMuted;
  if (verdict === 'proven') return colors.statusOk;
  if (verdict === 'weak' || verdict === 'missing') return colors.statusFail;
  if (verdict === 'untestable') return colors.statusWarn;
  return colors.accent;
}

export interface AcceptanceLedgerView {
  /** `1/3 proven`, the line the compact panel leads with. */
  counts: string;
  /** Long-form tally for the accessibility label. */
  countsLabel: string;
  /** True while any criterion is neither proven nor recorded untestable. */
  hasOpenCriteria: boolean;
  rows: Array<{
    criterion: AcceptanceCriterionView;
    /** The recorded verdict, or null while the criterion is unjudged. */
    verdict: string | null;
    color: string;
    /** Evidence basenames — a phone has no room for full paths. */
    evidence: string[];
  }>;
}

export function acceptanceLedgerView(
  ledger: AcceptanceStatusLedger,
  criteria: ReadonlyArray<AcceptanceCriterionRef> = ledger.criteria,
): AcceptanceLedgerView {
  const summary = summarizeAcceptanceStatus(ledger, criteria);
  return {
    counts: `${summary.proven}/${summary.total} proven`,
    countsLabel:
      `proven ${summary.proven}, weak ${summary.weak}, missing ${summary.missing}, ` +
      `untestable ${summary.untestable}, no verdict ${summary.unrecorded}`,
    hasOpenCriteria: summary.proven + summary.untestable < summary.total,
    rows: acceptanceCriteriaView(criteria, ledger).map((criterion) => ({
      criterion,
      verdict: criterion.status?.verdict ?? null,
      color: acceptanceVerdictColor(criterion.status?.verdict ?? null),
      evidence: (criterion.status?.evidence ?? []).map((path) => path.split('/').pop() || path),
    })),
  };
}
