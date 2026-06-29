import type { FlowType, RunLane, RunStatus } from './runs.js';

// ─── Pipeline-ops analytics ───
//
// A compact, append-only telemetry record emitted once per terminal run, decoupled
// from the prunable run-history store. Holds distilled metrics only — never
// transcripts or large step outputs. See docs/plans/pipeline-ops-analytics-goal.md.
//
// Token counts ARE captured (extraction became reliable via the gate-summary
// projection). Dollar cost stays absent on purpose — pricing varies by
// enterprise/subscription account and must be overridable per project, not a
// hardcoded table; it is deferred to a later cost lane.

/** Bumped when the on-disk record shape changes in a non-additive way. */
export const ANALYTICS_RECORD_SCHEMA_VERSION = 1;

/**
 * Normalized cause for a non-`done` terminal run. `operator-cancelled` describes a cancelled
 * terminal; the rest describe genuine step failures. (`blocked` is non-terminal in this system —
 * a blocked run emits when it later resolves to done/failed/cancelled — so it has no reason code.)
 */
export type FailureReason =
  | 'merge-conflict'
  | 'metro-timeout'
  | 'cdp-timeout'
  | 'dep-install'
  | 'auth'
  | 'ci-flake'
  | 'lint'
  | 'type'
  | 'test'
  | 'timeout'
  | 'operator-cancelled'
  | 'unknown';

export const FAILURE_REASONS: readonly FailureReason[] = [
  'merge-conflict',
  'metro-timeout',
  'cdp-timeout',
  'dep-install',
  'auth',
  'ci-flake',
  'lint',
  'type',
  'test',
  'timeout',
  'operator-cancelled',
  'unknown',
];

/** Machine-pressure snapshot captured at prepare start (forward-capture only). */
export interface HostLoadSnapshot {
  /** 1-minute load average (os.loadavg()[0]). */
  load1: number;
  /** Free memory as a percentage of total (0-100). */
  freeMemPct: number;
  /** Count of runs active on the same host when this run's prepare began. */
  activeRunsOnHost: number;
}

/** Per-step snapshot embedded in the run record. Final state of each step, not retry history. */
export interface AnalyticsStepRecord {
  name: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

/** One emitted record per terminal run. */
export interface RunAnalyticsRecord {
  schemaVersion: number;
  /** Terminal-transition timestamp (when the record was emitted). */
  ts: string;
  runId: string;
  familyId?: string;
  project: string;
  /** Machine the run landed on, derived from the slot id; `unknown` when unresolved. */
  host: string;
  slotId: string | null;
  flowType: FlowType;
  lane: RunLane;
  variant?: string | null;
  runner: string | null;
  model: string | null;
  status: RunStatus;
  outcome: 'success' | 'failure' | 'partial' | 'cancelled' | null;
  /** Step the run died at (failed step, else the last non-terminal step), or null for clean runs. */
  failedStep: string | null;
  failureReason: FailureReason | null;
  steps: AnalyticsStepRecord[];
  /** completedAt − createdAt. */
  wallMs: number | null;
  /** wallMs − Σ step durations: queue + human-gate + CI waiting. */
  idleMs: number | null;
  nudgeCount: number;
  /** Self-review attempt count when captured, else null. */
  selfReviewLoops: number | null;
  ciResult: string | null;
  ciPollCount: number | null;
  ciInlineFixAttempts: number | null;
  /**
   * Distinct human reviewers who requested changes, when captured. Forward-capture only: stored
   * per-run but not yet rolled up in AnalyticsQueryResult — reserved for the review-signals lane.
   */
  humanReviewersRequestingChanges: number | null;
  hostLoad: HostLoadSnapshot | null;
  /**
   * Total session tokens (worker), when captured; null when the runner reported
   * no usage. Optional: records emitted before token capture shipped omit it
   * entirely (readers treat absent and null alike).
   */
  totalTokens?: number | null;
  /**
   * Session tokens keyed by model id, when captured. Empty when no usage was
   * reported; absent on pre-token-capture records (readers default to `{}`).
   */
  tokensByModel?: Record<string, number>;
  /** Compact template identity for grouping; null when no provenance was captured. */
  templateKey: string | null;
  /** True when produced by the one-time backfill rather than a live terminal transition. */
  backfilled?: boolean;
}

// ─── Query / aggregation ───

export interface AnalyticsQueryParams {
  project?: string;
  host?: string;
  flowType?: FlowType;
  runner?: string;
  model?: string;
  lane?: RunLane;
  /** ISO lower bound on record ts (inclusive). */
  since?: string;
  /** ISO upper bound on record ts (exclusive). */
  until?: string;
}

export interface DurationStats {
  n: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

export interface BottleneckEntry {
  step: string;
  stats: DurationStats;
}

export interface LoopStats {
  distribution: Record<string, number>;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

export interface NudgeStats {
  avg: number;
  /** Fraction of runs with zero nudges (0-1). */
  zeroRate: number;
  /** Average nudge count keyed by model. */
  byModel: Record<string, number>;
}

export interface CiStats {
  resultBreakdown: Record<string, number>;
  pollCount: DurationStats;
  inlineFixAttempts: DurationStats;
}

/** Distinct filter values present in the scanned corpus, for UI dropdowns. */
export interface AnalyticsDimensions {
  projects: string[];
  hosts: string[];
  flowTypes: string[];
  runners: string[];
  models: string[];
}

export interface AnalyticsQueryResult {
  generatedAt: string;
  /** Records matching the filter. */
  matchedRuns: number;
  /** Records scanned before filtering. */
  scannedRuns: number;
  /** Corrupt sink lines skipped while reading; >0 means the numbers cover slightly fewer runs. */
  parseFailures: number;
  byStatus: Record<string, number>;
  byModel: Record<string, number>;
  /** Total session tokens summed by model id across matched runs. */
  tokensByModel: Record<string, number>;
  /** Distribution of per-run total session tokens. */
  tokens: DurationStats;
  byRunner: Record<string, number>;
  byTemplate: Record<string, number>;
  bottleneck: BottleneckEntry[];
  wall: DurationStats;
  idle: DurationStats;
  failureByStep: Record<string, number>;
  failureByReason: Record<string, number>;
  selfReviewLoops: LoopStats;
  ci: CiStats;
  nudges: NudgeStats;
  dimensions: AnalyticsDimensions;
}

export interface AnalyticsBackfillResult {
  scanned: number;
  written: number;
  skipped: number;
}
