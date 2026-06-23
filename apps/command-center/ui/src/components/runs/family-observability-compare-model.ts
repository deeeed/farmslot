import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import { evidenceSummary } from './family-observability-output-model.js';
import { formatDuration } from './run-utils.js';

export interface FamilyCopilotCompareRequest {
  prompt: string;
  intent: 'diagnostic-readonly';
  runId: string;
  sourceSurface: 'family-observability';
  contextOverride: {
    selectedFamilyId: string;
    selectedRunId: string;
    compareRunIds: string[];
    surfaceId: 'family-observability';
    affordances: string[];
  };
}

export function comparisonRuns(
  snapshot: Pick<FamilyObservabilitySnapshot, 'runs'>,
): FamilyObservabilityRunSummary[] {
  const comparison = snapshot.runs.filter((run) => run.lane === 'comparison');
  return comparison.length >= 2 ? comparison : [];
}

export function familyRunLabel(run: FamilyObservabilityRunSummary): string {
  return run.variant || `${run.metrics?.runner ?? 'runner'}-${run.metrics?.model ?? 'model'}`;
}

export function crossComparePrompt(
  snapshot: Pick<
    FamilyObservabilitySnapshot,
    'evidence' | 'familyId' | 'familyRootTicketOrPr' | 'runs'
  >,
): string {
  const rows = comparisonRuns(snapshot)
    .map((run) => {
      const evidence = evidenceSummary(snapshot, run);
      const diff = run.diffStat.available
        ? `${run.diffStat.files} files +${run.diffStat.additions}/-${run.diffStat.deletions}`
        : 'diff unavailable';
      return `- ${familyRunLabel(run)} (${run.runId}): status=${run.status}, runner=${run.metrics?.runner ?? '-'}, model=${run.metrics?.model ?? '-'}, slot=${run.slotId ?? '-'}, PR=${run.prNumber ?? '-'}, diff=${diff}, recipe=${run.recipeQuality.semantic}, evidence=${evidence}, selfReview=${run.selfReview.verdict ?? '-'}`;
    })
    .join('\n');
  return [
    `Cross-compare comparison family ${snapshot.familyId} for ${snapshot.familyRootTicketOrPr}.`,
    'Compare the candidate solutions by code delta, PR output, recipe/evidence quality, self-review findings, runtime risks, and missing data.',
    'Elect a winner if one is clearly safer; otherwise identify what evidence or cross-review is needed next.',
    '',
    rows,
  ].join('\n');
}

// ─── Comparison leaderboard / matrix model ───
//
// Both the leaderboard table and the N-column metric matrix render the same
// comparison-lane runs (`comparisonRuns`) against the same metric columns, so
// winner detection and the composite efficiency score live here as pure
// functions shared by both surfaces. `costEstimate` is intentionally excluded:
// it is populated on ~0% of runs (see pipeline-ops analytics findings) and would
// crown false winners.

export type CompareMetricDirection = 'lower-better' | 'higher-better' | 'none';

export interface CompareMetricColumn {
  key: string;
  label: string;
  direction: CompareMetricDirection;
  /** True when this column feeds the composite efficiency score. */
  scored: boolean;
  /** Numeric basis for winner detection and sorting; null when unavailable. */
  value: (run: FamilyObservabilityRunSummary) => number | null;
  /** Human-readable cell text; '—' when unavailable. */
  format: (run: FamilyObservabilityRunSummary) => string;
}

const EM_DASH = '—';

/** Compact integer formatting (e.g. 84_213 → "84.2k") for dense metric cells. */
export function formatCompactNumber(value: number | null | undefined): string {
  if (value == null) return EM_DASH;
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  const m = value / 1_000_000;
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

function recipeOrdinal(run: FamilyObservabilityRunSummary): number | null {
  switch (run.recipeQuality.semantic) {
    case 'good':
      return 2;
    case 'ok':
      return 1;
    case 'bad':
      return 0;
    default:
      return null; // 'unknown'
  }
}

function selfReviewOrdinal(run: FamilyObservabilityRunSummary): number | null {
  switch (run.selfReview.verdict) {
    case 'pass':
      return 2;
    case 'issues':
    case 'warn':
      return 1;
    case 'failed':
    case 'fail':
      return 0;
    default:
      return null;
  }
}

/** Tri-state CI signal: 1 = all checks green, 0 = any failing, null = no checks. */
function ciOrdinal(run: FamilyObservabilityRunSummary): number | null {
  if (run.ciChecks.length === 0) return null;
  const failing = run.ciChecks.some((check) =>
    ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(
      check.conclusion ?? '',
    ),
  );
  return failing ? 0 : 1;
}

function diffTotal(run: FamilyObservabilityRunSummary): number | null {
  if (!run.diffStat.available) return null;
  return run.diffStat.additions + run.diffStat.deletions;
}

export const COMPARE_METRIC_COLUMNS: CompareMetricColumn[] = [
  {
    key: 'duration',
    label: 'Duration',
    direction: 'lower-better',
    scored: true,
    value: (run) => run.metrics?.durationMs ?? null,
    format: (run) => formatDuration(run.metrics?.durationMs) || EM_DASH,
  },
  {
    key: 'totalTokens',
    label: 'Total tokens',
    direction: 'lower-better',
    scored: true,
    value: (run) => run.metrics?.sessionTotalTokens ?? null,
    format: (run) => formatCompactNumber(run.metrics?.sessionTotalTokens),
  },
  {
    key: 'outTokens',
    label: 'Output tokens',
    direction: 'lower-better',
    scored: true,
    value: (run) => run.metrics?.sessionOutputTokens ?? null,
    format: (run) => formatCompactNumber(run.metrics?.sessionOutputTokens),
  },
  {
    key: 'nudges',
    label: 'Nudges',
    direction: 'lower-better',
    scored: true,
    value: (run) => run.metrics?.nudgeCount ?? null,
    format: (run) => (run.metrics?.nudgeCount == null ? EM_DASH : `${run.metrics.nudgeCount}`),
  },
  {
    key: 'turns',
    label: 'Turns',
    direction: 'lower-better',
    scored: true,
    value: (run) => run.metrics?.sessionTurns ?? null,
    format: (run) => (run.metrics?.sessionTurns == null ? EM_DASH : `${run.metrics.sessionTurns}`),
  },
  {
    key: 'diff',
    label: 'Diff',
    direction: 'none',
    scored: false,
    value: diffTotal,
    format: (run) =>
      run.diffStat.available
        ? `${run.diffStat.files}f +${run.diffStat.additions}/-${run.diffStat.deletions}`
        : EM_DASH,
  },
  {
    key: 'recipe',
    label: 'Recipe',
    direction: 'higher-better',
    scored: false,
    value: recipeOrdinal,
    format: (run) => run.recipeQuality.semantic,
  },
  {
    key: 'selfReview',
    label: 'Self-review',
    direction: 'higher-better',
    scored: false,
    value: selfReviewOrdinal,
    format: (run) => run.selfReview.verdict ?? EM_DASH,
  },
  {
    key: 'ci',
    label: 'CI',
    direction: 'higher-better',
    scored: false,
    value: ciOrdinal,
    format: (run) => {
      const ci = ciOrdinal(run);
      return ci == null ? EM_DASH : ci === 1 ? 'pass' : 'fail';
    },
  },
];

export interface CompareLeaderboardCell {
  key: string;
  value: number | null;
  display: string;
  winner: boolean;
}

export interface CompareLeaderboardRow {
  runId: string;
  label: string;
  run: FamilyObservabilityRunSummary;
  /** Aligned 1:1 with {@link COMPARE_METRIC_COLUMNS}. */
  cells: CompareLeaderboardCell[];
  /** Composite efficiency score in [0,1] (1 = most efficient); null when no scored metric varies. */
  score: number | null;
  /** 1-based rank by score; rows with a null score sort last and share the trailing ranks. */
  rank: number;
}

export interface CompareLeaderboard {
  columns: CompareMetricColumn[];
  rows: CompareLeaderboardRow[];
  sortKey: string;
}

export const COMPARE_SORT_SCORE = 'score';

interface ColumnStats {
  best: number | null; // winning value, or null when the column has no contest
  min: number;
  max: number;
  defined: number;
}

function columnStats(
  column: CompareMetricColumn,
  runs: FamilyObservabilityRunSummary[],
): ColumnStats {
  const values = runs
    .map((run) => column.value(run))
    .filter((value): value is number => value != null);
  if (values.length < 2) return { best: null, min: 0, max: 0, defined: values.length };
  const min = Math.min(...values);
  const max = Math.max(...values);
  // 'none' columns (e.g. diff size) are informational — never crown a winner.
  // A column with no spread (every run identical) has nothing to crown either.
  const best =
    column.direction === 'none' || min === max
      ? null
      : column.direction === 'lower-better'
        ? min
        : max;
  return { best, min, max, defined: values.length };
}

/**
 * Per-row goodness in [0,1] for a scored column (1 = best). Missing values count
 * as worst (0) so a run can't top the leaderboard by lacking token/duration data.
 */
function goodness(column: CompareMetricColumn, stats: ColumnStats, value: number | null): number {
  if (stats.max === stats.min) return 1;
  const v = value ?? (column.direction === 'lower-better' ? stats.max : stats.min);
  const normalized = (v - stats.min) / (stats.max - stats.min);
  return column.direction === 'lower-better' ? 1 - normalized : normalized;
}

/**
 * Build the shared leaderboard/matrix model from already-filtered comparison
 * runs. `sortKey` is {@link COMPARE_SORT_SCORE} or a column key; default sorts by
 * composite efficiency score (most efficient first).
 */
export function buildComparisonLeaderboard(
  runs: FamilyObservabilityRunSummary[],
  sortKey: string = COMPARE_SORT_SCORE,
): CompareLeaderboard {
  const columns = COMPARE_METRIC_COLUMNS;
  const stats = new Map(columns.map((column) => [column.key, columnStats(column, runs)] as const));
  const scoredColumns = columns.filter(
    (column) => column.scored && stats.get(column.key)!.best != null,
  );

  const rows: CompareLeaderboardRow[] = runs.map((run) => {
    const cells = columns.map((column): CompareLeaderboardCell => {
      const value = column.value(run);
      const best = stats.get(column.key)!.best;
      return {
        key: column.key,
        value,
        display: column.format(run),
        winner: best != null && value != null && value === best,
      };
    });
    const score = scoredColumns.length
      ? scoredColumns.reduce(
          (sum, column) => sum + goodness(column, stats.get(column.key)!, column.value(run)),
          0,
        ) / scoredColumns.length
      : null;
    return { runId: run.runId, label: familyRunLabel(run), run, cells, score, rank: 0 };
  });

  sortLeaderboardRows(rows, columns, sortKey);
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
  return { columns, rows, sortKey };
}

function sortLeaderboardRows(
  rows: CompareLeaderboardRow[],
  columns: CompareMetricColumn[],
  sortKey: string,
): void {
  const column =
    sortKey === COMPARE_SORT_SCORE ? undefined : columns.find((c) => c.key === sortKey);
  // Score (default), an unknown key, and 'none'-direction columns (e.g. diff
  // size) have no inherent best-first order, so all rank by composite score.
  if (!column || column.direction === 'none') {
    rows.sort((a, b) => compareNullableNumbers(b.score, a.score) || a.label.localeCompare(b.label));
    return;
  }
  const cellValue = (row: CompareLeaderboardRow) =>
    row.cells.find((cell) => cell.key === sortKey)?.value ?? null;
  rows.sort((a, b) => {
    const av = cellValue(a);
    const bv = cellValue(b);
    // Best-first: ascending for lower-better, descending for higher-better.
    const ordered =
      column.direction === 'higher-better'
        ? compareNullableNumbers(bv, av)
        : compareNullableNumbers(av, bv);
    return ordered || a.label.localeCompare(b.label);
  });
}

/** Ascending compare with nulls sorted last regardless of direction. */
function compareNullableNumbers(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

export function familyCopilotCompareRequest(
  snapshot: Pick<
    FamilyObservabilitySnapshot,
    'evidence' | 'familyId' | 'familyRootTicketOrPr' | 'latestRunId' | 'runs'
  >,
  selectedRunId: string,
): FamilyCopilotCompareRequest {
  const targetRunId = selectedRunId || snapshot.latestRunId;
  return {
    prompt: crossComparePrompt(snapshot),
    intent: 'diagnostic-readonly',
    runId: targetRunId,
    sourceSurface: 'family-observability',
    contextOverride: {
      selectedFamilyId: snapshot.familyId,
      selectedRunId: targetRunId,
      compareRunIds: comparisonRuns(snapshot).map((run) => run.runId),
      surfaceId: 'family-observability',
      affordances: ['comparison-lane-analysis', 'winner-selection', 'evidence-provenance'],
    },
  };
}
