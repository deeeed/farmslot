/**
 * Presentation of checklist progress for the mobile panels: the step-row colour
 * both levels share, plus the child checklist unit header (ADR-060). The
 * projection itself comes from the gateway — this only decides labels, colours,
 * and whether a child's steps list starts collapsed.
 */
import {
  createEvidenceReviewModel,
  type EvidenceReviewClaim,
  type EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';
import {
  type AcceptanceCriterionRef,
  type AcceptanceCriterionView,
  type AcceptanceEvidenceLink,
  type AcceptanceStatusLedger,
  isSettledSubtaskStatus,
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
  if (verdict === 'weak' || verdict === 'missing' || verdict === 'failed') return colors.statusFail;
  if (verdict === 'untestable') return colors.statusWarn;
  return colors.accent;
}

export interface AcceptanceEvidenceEntry {
  /** Task-dir relative path, as the ledger records it. */
  path: string;
  /** Basename — a phone has no room for full paths. */
  name: string;
}

export interface AcceptanceLedgerRow {
  review?: EvidenceReviewClaim;
  criterion: AcceptanceCriterionView;
  /** The recorded verdict, or null while the criterion is unjudged. */
  verdict: string | null;
  color: string;
  evidence: AcceptanceEvidenceEntry[];
}

export interface AcceptanceLedgerView {
  /** Assessment progress and proven criteria are separate counts. */
  counts: string;
  /** Long-form tally for the accessibility label. */
  countsLabel: string;
  /** Fail colour while any registered criterion has no verdict, neutral otherwise. */
  countsColor: string;
  /** Registered criteria with no verdict recorded yet. */
  unassessed: number;
  /** True while any criterion is neither proven nor recorded untestable. */
  hasOpenCriteria: boolean;
  rows: AcceptanceLedgerRow[];
}

/**
 * @param evidenceLinks Manifest `covers` links for a run with no ledger. They only
 * fill a row's evidence when that criterion has no recorded verdict, and never
 * count as one.
 */
export function acceptanceLedgerView(
  ledger: AcceptanceStatusLedger,
  criteria: ReadonlyArray<AcceptanceCriterionRef> = ledger.criteria,
  evidenceLinks: ReadonlyArray<AcceptanceEvidenceLink> = [],
  model: EvidenceReviewModel = createEvidenceReviewModel({ criteria, ledger, evidenceLinks }),
): AcceptanceLedgerView {
  const summary = model.summary;
  const assessed = summary.total - summary.unrecorded;
  return {
    counts: `${assessed}/${summary.total} assessed · ${summary.proven} proven`,
    countsLabel:
      `proven ${summary.proven}, weak ${summary.weak}, missing ${summary.missing}, ` +
      `untestable ${summary.untestable}, not assessed ${summary.unrecorded}`,
    // An unjudged criterion blocks a publish decision, so the tally must not read as neutral.
    countsColor: summary.unrecorded > 0 ? colors.statusFail : colors.textSecondary,
    unassessed: summary.unrecorded,
    hasOpenCriteria: summary.proven + summary.untestable < summary.total,
    rows: model.claims.map((criterion) => ({
      criterion,
      review: criterion,
      verdict: criterion.status?.verdict ?? null,
      color: acceptanceVerdictColor(criterion.status?.verdict ?? null),
      evidence: criterion.evidence.map(({ artifactPath, name }) => ({ path: artifactPath, name })),
    })),
  };
}

/**
 * React key for a child unit block. The block keeps the viewer's expand state
 * in component state, so a run change must remount it rather than carry the
 * previous run's state over — the same rule Command Center applies with its
 * run-scoped map.
 *
 * `no-run` is a fallback, not a normal case: every screen that renders
 * structured progress (run detail, slot workspace, decision workspace) has a
 * run in hand, and a child unit only exists inside a run's task directory.
 */
export function subtaskBlockKey(runId: string | null | undefined, unitId: string): string {
  return `${runId?.trim() || 'no-run'}:${unitId}`;
}
