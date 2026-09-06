import type { ArtifactRef, SelfReviewIssue } from '../recipes/step-io.js';
import type {
  WorkerSignalChecklistEvent,
  WorkerSignalChecklistTiming,
} from '../transport/signal.js';

import type {
  AgentContext,
  AgentContextTarget,
  SafetyTier,
  ScriptedRunnerConfig,
} from './agents.js';
import type { FailureCategory, RunRecoveryProposalConfidence } from './chat.js';
import type { TaskTemplateSelection, TemplateProvenance } from './evals.js';
import type { EvidenceQualityReport, RecipeQualityArtifact } from './recipes.js';
import type { ResourcePostureWaitPolicy, RunResourcePostureState } from './resource-posture.js';
import type { ResourceType } from './resources.js';
import type { RunImportProvenance } from './run-bundles.js';
import type { RuntimeCapabilityProofRequirement } from './runtime-capabilities.js';
import type { SlotHealth } from './slots.js';
import type { ProfileFitSuggestion, ValidationPlanStep } from './validation-plan.js';

// ─── Runs ───

export type RunStatus =
  | 'created'
  | 'grading'
  | 'writing-task'
  | 'slot-finding'
  | 'preparing'
  | 'dispatching'
  | 'monitoring'
  | 'self-reviewing'
  | 'completing'
  | 'human-gating'
  | 'ci-watching'
  | 'paused'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['done', 'failed', 'cancelled'];

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'grading',
  'writing-task',
  'slot-finding',
  'preparing',
  'dispatching',
  'monitoring',
  'self-reviewing',
  'completing',
  'ci-watching',
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Runs eligible for activate-on-slot re-bind (ADR-024 §7 addendum): terminal
 * runs plus `blocked` (a run parked at a gate the operator can re-engage).
 * Active runs (preparing/dispatching/monitoring/…) and `created` are excluded —
 * re-driving them from PREPARE would kill a live worker or pre-empt normal
 * dispatch. Shared by the gateway guard and all UI entry points so the
 * server and client agree on which runs show/accept the action.
 */
export function canActivateRunOnSlot(status: RunStatus): boolean {
  return isTerminalRunStatus(status) || status === 'blocked';
}

export type RunStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface RunStep {
  name: string;
  status: RunStepStatus;
  detail?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

export type LiveRecipeSource =
  | 'decision'
  | 'recipe-run-live'
  | 'recipe-run-artifacts'
  | 'final-artifacts';

export type LiveRecipeSelectionReason =
  | 'latest-run'
  | 'user-selected'
  | 'decision-derived'
  | 'fallback-none';

export interface LiveRecipeContext {
  source: LiveRecipeSource;
  recipeRunId: string | null;
  artifactRoot: string | null;
  artifactManifest: ArtifactRef[] | null;
  usedTypedArtifactManifest?: boolean;
  recipeJson: string | null;
  recipeQualityArtifact: RecipeQualityArtifact | null;
  qualityReport: EvidenceQualityReport | null;
  workerLearnings: string | null;
  isStale: boolean;
  selectionReason: LiveRecipeSelectionReason;
}

export const LIVE_RECIPE_EVIDENCE_PURPOSES = new Set([
  'screenshot',
  'video',
  'video-before',
  'video-after',
]);

export const LIVE_RECIPE_EVIDENCE_FILES = new Set(['summary.json', 'trace.json']);

export function hasLiveRecipeEvidence(
  context: Pick<
    LiveRecipeContext,
    | 'recipeJson'
    | 'recipeQualityArtifact'
    | 'qualityReport'
    | 'workerLearnings'
    | 'artifactManifest'
  >,
): boolean {
  return (
    Boolean(
      context.recipeJson ||
      context.recipeQualityArtifact ||
      context.qualityReport ||
      context.workerLearnings,
    ) ||
    Boolean(
      context.artifactManifest?.some((artifact) => {
        const filename = artifact.path.split(/[\\/]/).pop() ?? artifact.path;
        return (
          LIVE_RECIPE_EVIDENCE_PURPOSES.has(artifact.purpose) ||
          LIVE_RECIPE_EVIDENCE_FILES.has(filename)
        );
      }),
    )
  );
}

export type RecipeRunArtifactGroupKind = 'current-artifacts' | 'latest-valid' | 'live-run';
export type RecipeRunArtifactGroupStatus = 'pass' | 'fail' | 'unknown';

export interface RecipeRunArtifactGroup extends LiveRecipeContext {
  id: string;
  label: string;
  groupKind: RecipeRunArtifactGroupKind;
  promoted: boolean;
  status: RecipeRunArtifactGroupStatus;
}

export interface ReviewLineComment {
  path: string;
  line: number;
  body: string;
  severity: string;
}

export interface EvidenceManifestStandalone {
  label: string;
  covers?: string[];
  file: string;
  note?: string;
}

export interface ReviewGatePayload {
  kind: 'review';
  prNumber: number | null;
  repo: string | null;
  /** PR/project base branch used by the review diff workspace. */
  baseRef?: string;
  recommendation: string;
  reviewMd: string;
  lineComments: ReviewLineComment[];
  artifactManifest?: EvidenceManifestEntry[];
  artifactUrls?: Record<string, string>;
  reviewSnapshot?: ReviewDiffSnapshot;
  reviewInputArtifactPaths?: string[];
  stale?: boolean;
  evidenceMarkdown?: string;
  recipeJson?: string;
  recipeQualityArtifact?: RecipeQualityArtifact | null;
  qualityReport?: EvidenceQualityReport | null;
  workerLearnings?: string;
}

export type PublicationTarget = 'draft' | 'ready';
export type PublicationStatus =
  | 'not_published'
  | 'pending_publish'
  | 'published_draft'
  | 'published_ready'
  | 'publish_failed';

export interface ReviewDepthPolicy {
  minimumIndependentReviews: number;
  requireCrossRunner: boolean;
  /** Independent review loops required beyond `minimumIndependentReviews`. */
  extraLoopsRequested: number;
  /** V2 counts the first configured loop in the minimum, not again as an extra. */
  countingVersion?: 2;
  requestedBy: 'dispatch' | 'human-gate' | 'agent-gate';
}

/**
 * Reviewer session lifecycle across one run's review loops:
 * `fresh-per-pass` relaunches a cold reviewer every pass; `warm-per-reviewer`
 * resumes the same reviewer runner session for re-reviews within the run.
 * Warm is the default: after the worker fixes findings, the re-review resumes
 * the reviewer's context instead of rebuilding the whole review. First passes
 * are always cold; runners without session reload fall back to cold.
 */
export type ReviewSessionPolicy = 'fresh-per-pass' | 'warm-per-reviewer';

export const REVIEW_SESSION_POLICIES: readonly ReviewSessionPolicy[] = [
  'fresh-per-pass',
  'warm-per-reviewer',
];

export const DEFAULT_REVIEW_SESSION_POLICY: ReviewSessionPolicy = 'warm-per-reviewer';

export type ReviewValidationDepth = 'static-code' | 'full-live';

export type ReviewScope = 'incremental' | 'full';

export const REVIEW_SCOPES: readonly ReviewScope[] = ['incremental', 'full'];

export function isReviewScope(value: unknown): value is ReviewScope {
  return typeof value === 'string' && (REVIEW_SCOPES as readonly string[]).includes(value);
}

export const REVIEW_VALIDATION_DEPTHS: readonly ReviewValidationDepth[] = [
  'static-code',
  'full-live',
];

export function isReviewValidationDepth(value: unknown): value is ReviewValidationDepth {
  return (
    typeof value === 'string' && (REVIEW_VALIDATION_DEPTHS as readonly string[]).includes(value)
  );
}

export function reviewValidationDepthForLoop(
  _index: number,
  _total: number,
): ReviewValidationDepth {
  return 'static-code';
}

/** Whether a repeat review should resume prior reviewer reasoning or start clean. */
export type ReviewSessionIntent = 'resume' | 'reset';

/** What actually happened when the reviewer generation launched. */
export type ReviewSessionContinuity = 'fresh' | 'resumed' | 'fallback-fresh' | 'resume-unconfirmed';

export type ReviewSessionFallbackReason =
  | 'unsupported-runner'
  | 'slot-mismatch'
  | 'runner-mismatch'
  | 'missing-session'
  | 'session-unavailable';

export interface ReviewSessionTrace {
  intent: ReviewSessionIntent;
  continuity: ReviewSessionContinuity;
  priorRunId?: string;
  priorSessionId?: string;
  sessionId?: string;
  fallbackReason?: ReviewSessionFallbackReason;
}

/** Frozen summary for one run in a repeated-PR review chain. */
export interface ReviewChainEntry {
  chainId: string;
  generation: number;
  runId: string;
  familyId: string;
  repository: string;
  prNumber: number;
  baseSha?: string;
  headSha?: string;
  reviewScope: ReviewScope;
  validationDepth: ReviewValidationDepth;
  verdict: string;
  unresolvedCount: number | null;
  artifactRefs: EvidenceManifestEntry[];
  runner?: string | null;
  model?: string | null;
  session?: ReviewSessionTrace;
  createdAt: string;
  completedAt?: string;
}

export interface RepeatReviewContext {
  version: 1;
  chainId: string;
  generation: number;
  contextMode: 'reuse' | 'fresh';
  priorRunId: string;
  priorFamilyId: string;
  repository: string;
  prNumber: number;
  priorReviewedHeadSha?: string;
  currentHeadSha: string;
  baseRef?: string;
  verdict: string;
  unresolvedFindings: SelfReviewIssue[];
  artifactRefs: EvidenceManifestEntry[];
  farmslotEvidenceRefs: EvidenceManifestEntry[];
  originatingRunId?: string;
  reviewScope: ReviewScope;
  validationDepth: ReviewValidationDepth;
  incrementalUnavailableReason?: string;
  /** Incremental may resume; every full review resets reviewer reasoning. */
  sessionIntent?: ReviewSessionIntent;
  /** Dispatch-time observation of the requested reviewer-session transition. */
  session?: ReviewSessionTrace;
  /** Completed predecessors, oldest first. The current run is derived from this Run record. */
  priorGenerations?: ReviewChainEntry[];
}

export interface ReviewLoopRequest {
  order: number;
  runner: 'same' | ReviewRunnerId;
  model?: string | null;
  validationDepth?: ReviewValidationDepth;
  /** Resume this run's reviewer context, or reset it before this review generation. */
  sessionIntent?: ReviewSessionIntent;
}

export type ReviewRunnerId = 'claude' | 'codex' | 'cursor' | 'grok' | 'opencode';
export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}
export interface EvidenceManifestEntry {
  path: string;
  purpose: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface ReviewDiffSnapshot {
  baseRef?: string | null;
  baseSha?: string | null;
  headRef?: string | null;
  headSha?: string | null;
  diffPath?: string | null;
  diffHash?: string | null;
  diffStat?: DiffStat;
  untrackedFiles?: Array<{
    path: string;
    blobSha: string;
    mode: '100644' | '100755' | '120000';
  }>;
  capturedAt: string;
  source: 'local-git' | 'github-pr' | 'unavailable';
  missingReason?: string;
  error?: string;
}

export interface ReviewFixDeltaSnapshot extends ReviewDiffSnapshot {
  fixBaseSha?: string | null;
  fixHeadSha?: string | null;
}

export interface RunnerSessionUsage {
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
  runner?: string | null;
  actualModel?: string | null;
  turns?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreation?: number | null;
  cacheRead?: number | null;
  reasoningOutputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  measuredAt: string;
  source: 'runner-transcript' | 'unavailable';
  /** What this measurement covers. `session-total` is the runner transcript total at measurement time. */
  scope?: 'session-total';
  error?: string;
}

export type ReviewLoopTimelineSegmentKind = 'review' | 'worker-fix' | 're-review';

export interface ReviewLoopTimelineSegment {
  kind: ReviewLoopTimelineSegmentKind;
  loopNumber: number;
  runner?: string | null;
  model?: string | null;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  verdict?: IndependentReviewAttempt['verdict'];
  unresolvedCount?: number;
  artifactPaths?: string[];
}

export interface IndependentReviewAttempt {
  loopNumber: number;
  verdict: 'pending' | 'pass' | 'issues' | 'failed' | 'cancelled' | 'skipped';
  unresolvedCount: number;
  /** Transport/lifecycle explanation when a review did not complete normally. */
  reason?: string;
  issues?: SelfReviewIssue[];
  validationDepth?: ReviewValidationDepth;
  usage?: RunnerSessionUsage;
  /** Checklist marks and timings captured from this review round's role-scoped signal. */
  checklistTiming?: WorkerSignalChecklistTiming;
  reviewSnapshot?: ReviewDiffSnapshot;
  fixDelta?: ReviewFixDeltaSnapshot;
  artifactPaths?: string[];
  taskProgressArtifactPath?: string;
  timeline?: ReviewLoopTimelineSegment[];
  startedAt?: string;
  completedAt?: string;
}

export interface IndependentReviewStatus {
  id: string;
  source?: 'dispatch' | 'human-gate' | 'self-review';
  runner?: string | null;
  model?: string | null;
  reviewerSessionId?: string | null;
  crossRunner: boolean;
  loopNumber: number;
  verdict: 'pending' | 'pass' | 'issues' | 'failed' | 'cancelled' | 'skipped';
  unresolvedCount: number;
  /** Transport/lifecycle explanation when a review did not complete normally. */
  reason?: string;
  issues?: SelfReviewIssue[];
  validationDepth?: ReviewValidationDepth;
  usage?: RunnerSessionUsage;
  feedbackSent?: boolean;
  /** Restart recovery explicitly owes this review a worker fix/re-review continuation. */
  recoveryContinuationPending?: boolean;
  attempts?: IndependentReviewAttempt[];
  artifactPaths?: string[];
  taskProgressArtifactPath?: string;
  timeline?: ReviewLoopTimelineSegment[];
  reviewSnapshot?: ReviewDiffSnapshot;
  reviewedHeadSha?: string | null;
  reviewedPackageInputHash?: string | null;
  reviewedReviewSubjectHash?: string | null;
  fixDelta?: ReviewFixDeltaSnapshot;
  stale?: boolean;
  startedAt?: string;
  completedAt?: string;
}

export const PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES = {
  launchRejected: 'PUBLICATION_REVIEW_LAUNCH_REJECTED',
  gitProbeFailed: 'PUBLICATION_REVIEW_GIT_PROBE_FAILED',
} as const;

export type PublicationReviewLaunchRejectionCode =
  (typeof PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES)[keyof typeof PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES];

/** Recoverable refusal captured when a publication reviewer cannot safely launch. */
export interface PublicationReviewLaunchRejection {
  code: PublicationReviewLaunchRejectionCode;
  message: string;
  userAction: string;
  details?: unknown;
  rejectedAt: string;
}

export interface GatePolicy {
  owner: 'human' | 'agent';
  dispatchMode?: 'interactive' | 'autonomous' | 'validation';
  publishAuthority: 'human' | 'agent';
  reason: string;
}

/**
 * Canonical {@link GateSummary.kind} values — one per gate surface. Use these
 * instead of bare string literals. The `kind` field stays widenable (`| string`)
 * so a new flow can introduce its own without a protocol change.
 */
export const GATE_SUMMARY_KINDS = {
  publication: 'publication',
  bugfix: 'bugfix',
  demo: 'demo',
  review: 'review',
  ci: 'ci',
} as const;

export type GateSummaryKind = (typeof GATE_SUMMARY_KINDS)[keyof typeof GATE_SUMMARY_KINDS];

/**
 * Consolidated, flow-agnostic "what happened to reach this gate" snapshot.
 *
 * One model reused across every gate/retrospective surface (publication gate,
 * retrospective, family observability). Outcome-first: the worker phase and the
 * review outcomes are the headline; token cost is a supporting section.
 *
 * Built by `buildGateSummary` in the gateway by *projecting* already-captured
 * state ({@link IndependentReviewStatus}, {@link RunMetrics}, family runs) — it
 * does not re-derive review state or re-read artifacts.
 */
export interface GateSummary {
  /** Which gate surface produced this. Generic so new flows can extend it. */
  kind: GateSummaryKind | (string & {});
  flowType?: FlowType;
  /** Who owns/authorizes the gate and why (reused from the gate policy). */
  gatePolicy?: GatePolicy;
  /** One-line human narrative, e.g. "Worker done in 55 turns; self-review skipped (lightweight dev); 0 reviews triggered re-work." */
  headline?: string;
  worker: {
    model: string | null;
    turns: number;
    outcome?: 'success' | 'failure' | 'partial' | 'cancelled';
  };
  review: ReviewSummary;
  tokens: GateTokenSummary;
  /**
   * Per-step checklist timing derived from the worker's persisted
   * `checklistTiming` (SIGNAL.json). Optional — absent when the run predates
   * timing persistence or the worker never marked steps. `perStepMs` holds the
   * duration of each step (delta between consecutive `checkedAt` timestamps).
   */
  checklist?: {
    events: WorkerSignalChecklistEvent[];
    perStepMs: Array<{ stepNumber: number; label: string; durationMs: number }>;
  };
  /** Flow-specific extras (e.g. CI-watch counts for a `ci` gate). */
  custom?: Record<string, unknown>;
  capturedAt?: string;
}

/** Review outcomes for a gate, projected from self-review + independent reviews. */
export interface ReviewSummary {
  selfReview?: {
    status: 'skipped' | 'done' | 'failed' | 'pending';
    /** Descriptive reason when skipped/failed, e.g. "disabled-lightweight-dev-flow". */
    reason?: string;
    verdict?: string;
    feedbackSent: boolean;
    unresolvedCount: number;
    triggeredReWork: boolean;
    artifactPaths?: string[];
  };
  /** Projected from {@link IndependentReviewStatus} — outcome-first, no raw artifacts. */
  independentReviews: Array<{
    id: string;
    source?: 'dispatch' | 'human-gate' | 'self-review';
    runner?: string | null;
    model?: string | null;
    crossRunner: boolean;
    loopNumber: number;
    verdict: 'pending' | 'pass' | 'issues' | 'failed' | 'cancelled' | 'skipped';
    unresolvedCount: number;
    feedbackSent: boolean;
    /** `feedbackSent` followed by another attempt/loop — i.e. the review caused re-work. */
    triggeredReWork: boolean;
    attempts: number;
    stale?: boolean;
    startedAt?: string;
    completedAt?: string;
  }>;
  /** Reviews required by the gate's {@link ReviewDepthPolicy}, if any. */
  requiredReviews?: number;
  passingReviews: number;
  totalUnresolved: number;
  didAnyReviewTriggerReWork: boolean;
  summaryText?: string;
}

/** Token cost of reaching a gate, including chained family fix-loops. */
export interface GateTokenSummary {
  mainWorker: {
    model: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
    turns: number;
  };
  /**
   * Per independent review (from {@link IndependentReviewStatus.usage}). The
   * input/output/cache split is present when the review's usage record carried
   * it; older entries may only have `total`.
   */
  reviews: Array<{
    id: string;
    model: string | null;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
    total: number;
  }>;
  /**
   * Token totals grouped by model across worker + reviews + family fix-loops.
   * The single scannable "what did each model cost us, in tokens" rollup. `input`
   * etc. sum only the entries that carried a split; `total` always covers every
   * entry for that model.
   */
  byModel: Array<{
    model: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
    turns: number;
  }>;
  /**
   * Work attributable to review-triggered re-work — family fix-loops plus human
   * nudges. Tokens/turns only; dollar cost is intentionally deferred (pricing is
   * unreliable across enterprise/subscription accounts).
   */
  reWork?: {
    tokens: number;
    loops: number;
    turns?: number;
    nudgeCount?: number;
  };
  /** pr-complete / update-branch fix loops in the same family that ran after this gate's run. */
  familyChainedLoops?: Array<{
    runId: string;
    flowType: FlowType;
    role: 'fix-loop' | 'review';
    model: string | null;
    tokens: {
      input: number;
      output: number;
      total: number;
      cacheRead: number;
      cacheCreation: number;
    };
    perTurnSessionPath?: string;
    createdAt: string;
  }>;
  /** mainWorker + reviews + all familyChainedLoops. */
  familyTotalTokens: number;
  perTurnDetailsAvailable: boolean;
  /** All runner-session JSONL paths backing this summary, for per-turn drill-down. */
  runnerSessionPaths?: string[];
}

export interface ReadyGatePrPackage {
  id: string;
  packageHash: string;
  packageInputHash?: string;
  reviewSubjectHash?: string;
  artifactPath: string;
  branch: string;
  remoteBranchRef?: string | null;
  headSha?: string;
  diffStat: DiffStat;
  /** Exact worktree diff identity captured with the same scope as independent reviews. */
  reviewSnapshot?: ReviewDiffSnapshot;
  draftTitle: string;
  draftBody: string;
  evidenceManifest?: EvidenceManifestEntry[];
  selectedEvidenceKeys?: string[];
  validationSummaryPath?: string | null;
  validationSummaryHash?: string | null;
  reviewArtifactIds: string[];
  dispatchMode?: 'interactive' | 'autonomous' | 'validation';
  gatePolicy: GatePolicy;
  /** Frozen at package preparation time so approval/review policy cannot drift with config edits. */
  reviewDepth?: ReviewDepthPolicy;
  publicationTarget: PublicationTarget;
  publicationStatus: PublicationStatus;
  supersededByPackageId?: string | null;
  createdAt: string;
  approvedAt?: string;
}

export interface ReadyGateInputSnapshot {
  ticketData?: RunTicketData;
  taskFile?: string | null;
  taskPrompt?: string;
  initialContext?: string;
  checklist?: string[];
  templateProvenance?: TemplateProvenance | null;
}

export interface ReadyGatePayload {
  kind: 'ready';
  prNumber: number | null;
  repo: string | null;
  diffStat: DiffStat;
  workerReport: string;
  branch: string;
  slotId?: string;
  /**
   * Commit SHA the slot's branch pointed at when this gate was created.
   * Persisted so post-hoc viewers of a resolved gate know whether the
   * slot has moved on — the live diff in `ready-workspace` is against the
   * current HEAD, which may differ from what was reviewed. Undefined on
   * gates created before this field was introduced.
   */
  headSha?: string;
  recipeJson?: string;
  recipeQualityArtifact?: RecipeQualityArtifact | null;
  qualityReport?: EvidenceQualityReport | null;
  artifactManifest?: EvidenceManifestEntry[];
  selfReviewVerdict?: string;
  selfReviewSummary?: string;
  workerLearnings?: string;
  ciChecks?: Array<{ name: string; status: string; conclusion: string | null }>;
  acceptanceCriteria?: string[];
  inputSnapshot?: ReadyGateInputSnapshot;
  prPackage?: ReadyGatePrPackage;
  reviewDepth?: ReviewDepthPolicy;
  independentReviews?: IndependentReviewStatus[];
  reviewLaunchRejection?: PublicationReviewLaunchRejection;
  gatePolicy?: GatePolicy;
  /** Consolidated "what happened to reach this gate" snapshot (worker → reviews → cost). */
  gateSummary?: GateSummary;
  validationSummary?: string;
  publicationTarget?: PublicationTarget;
  publicationStatus?: PublicationStatus;
  stale?: boolean;
  draftEdits?: {
    title?: string;
    body?: string;
    selectedEvidenceKeys?: string[];
  };
  /**
   * Audit trail for the human evidence-refresh publish override
   * (`approve-publish-evidence-refresh`). Recorded when an operator carries a
   * stale-by-evidence-drift pass verdict forward onto the current package
   * without a re-review. Absent on every other approval path.
   */
  evidenceRefreshOverride?: EvidenceRefreshOverrideRecord;
  /**
   * Soft gate: commits the slot branch is behind origin/<defaultBranch>
   * (`git rev-list --count HEAD..origin/<branch>`). Chip only — not a hard fail.
   * Absent when the probe could not run.
   */
  behindMain?: number;
  /**
   * Soft gate: non-destructive merge-tree conflict probe against origin/<defaultBranch>.
   * Chip only — not a hard fail. Absent when the probe could not run.
   */
  mergeConflicts?: boolean;
  /** Sample conflict paths from the merge-tree probe (capped). */
  mergeConflictPaths?: string[];
  /** Operator-facing next command (merge preferred during open review loops). */
  branchFreshnessHint?: string;
}

export interface EvidenceRefreshOverrideRecord {
  at: string;
  operator: string | null;
  restampedReviewIds: string[];
  oldReviewSubjectHashes: string[];
  newReviewSubjectHash: string;
}

export interface NoChangeGatePayload {
  kind: 'no-change';
  disposition: WorkerTerminalDisposition;
  reason?: string;
  evidence?: WorkerTerminalEvidence;
  workerReport?: string;
  artifactManifest?: EvidenceManifestEntry[];
}

export interface SlotPickerPayload {
  kind: 'slot_picker';
  project: string;
  candidates: Array<{
    slotId: string;
    score: number;
    branch: string;
    lifecycle: string;
    health: SlotHealth;
    machine: string;
  }>;
  reason: 'no_free_slots' | 'all_stale' | 'all_unhealthy' | 'missing_required_resources';
}

/**
 * Branch-affinity nudge — surfaced when a busy slot is already on the target PR's branch
 * and the operator can reuse its loaded context instead of dispatching fresh on a stale slot.
 *
 * Emitted by FIND_SLOT only for headless entry points (CI-watch chained pr-complete after CI
 * fail, CLI dispatch, gateway restart recovery). The dispatch wizard surfaces the same data
 * inline via DispatchCandidatesResult.nudgeMeta and bypasses this card entirely.
 */
export interface BranchAffinityNudgePayload {
  kind: 'branch_affinity_nudge';
  project: string;
  ticketOrPr: string;
  prNumber?: number | null;
  candidate: {
    slotId: string;
    machine: string;
    branch: string;
    /** Runner currently active in the slot. Should always be populated when the candidate is
     * surfaced (the eligibility gate requires a runner with `supportsTmuxNudges`), but typed
     * as nullable to mirror `SlotStatus.runner` and avoid empty-string sentinels. */
    runner: string | null;
    /** Model of the prior worker, when known. Often null for legacy slots that never recorded one. */
    model: string | null;
    nudgeCount: number;
    /** Runner context-window usage percentage (0-100). Runner-agnostic; populated by whichever
     * node-side adapter knows how to read the active runner's status surface. Null when the
     * runner does not expose a value or the parse failed. */
    ctxPct: number | null;
    agentStatus: string;
    dispatchedAt: string | null;
    /** Run id currently bound to the slot — i.e., the prior run that nudge would supersede.
     * Read this as "priorRunId" at decision time; the field is named `currentRunId` to mirror
     * `SlotStatus.currentRunId` so wire-format consumers don't have to think about renames. */
    currentRunId: string | null;
    currentFlowType: string | null;
    uncommittedCount: number;
    /** First 10 paths from `git status --porcelain`. */
    uncommittedFiles: string[];
    /** Whether the match is an authoritative `prHealth.pr === prNumber` hit or a softer branch-slug-only match. */
    prMatchKind: 'pr-number' | 'branch-slug';
    /** True when the slot's runner supports tmux send-keys nudges. UI uses this to disable the
     * Nudge action button when false — only Fresh dispatch is offered for codex / opencode. */
    canNudge: boolean;
  };
  /** Free-slot fallback list. Reused from {@link SlotPickerPayload.candidates} so the 'pick'
   * action renders through the existing slot-picker UI without a second payload type. The
   * type alias is intentional: if SlotPicker's row shape evolves the nudge card inherits the
   * change. If they need to diverge, peel the alias and add explicit fields here. */
  freeSlotCandidates: SlotPickerPayload['candidates'];
  /** Soft warnings (e.g. 'family-mismatch', 'high-nudge-count', 'high-ctx-pct'). */
  riskFlags: string[];
}

export interface ImprovementFileChange {
  filePath: string;
  before: string;
  after: string;
}

export interface ImprovementDiffPayload {
  kind: 'improvement';
  learningContent: string;
  proposedChanges: ImprovementFileChange[];
  rationale: string;
  sourceRunId: string;
  project: string;
  analysisStatus?: 'analyzing' | 'completed' | 'no-content' | 'no-changes' | 'error';
  analysisStartedAt?: string;
  analysisError?: string;
  /**
   * How many times analysis has been started for this placeholder (initial
   * run + startup resumes). Bounds crash-loop retries: startup recovery
   * re-runs an interrupted `analyzing` placeholder only while below the cap.
   */
  analysisAttempts?: number;
}

export interface CommentsTriageSummary {
  total: number;
  real: number;
  falsePositive: number;
  outOfScope: number;
  fixed: number;
  botAddressed?: number;
  humanReviewersRequestingChanges?: number;
  humanCommentsAddressed?: number;
  unknownSource?: number;
  actionablePaths?: string[];
}

export interface RetrospectivePayload {
  kind: 'retrospective';
  outcome: 'success' | 'failure' | 'partial' | 'cancelled' | 'unknown';
  whatThisIs: string;
  selfReviewVerdict?: string;
  selfReviewSummary?: string;
  workerLearnings?: string;
  reportExcerpt?: string;
  ciWatch?: {
    result?: string;
    passed?: number;
    failed?: number;
    pending?: number;
    total?: number;
  };
  actionEffects: Array<{
    actionId: string;
    summary: string;
  }>;
  rootRunId?: string;
  rootLearnings?: string;
  deltaLearnings?: string;
  commentsTriageSummary?: CommentsTriageSummary;
  /** Consolidated "what happened" snapshot, shared with the publication gate. */
  gateSummary?: GateSummary;
}

/** Engine-collision decision payload — surfaces the prior runs that own the colliding
 *  task dirs so UI can deep-link to them (and let the operator retry from there)
 *  instead of forking a new family via `create-new`. priorRunIds is ordered newest-first.
 *  dirOwners maps each colliding dir to the owning run id (when resolved at decision
 *  creation); UI uses it to render per-dir chip links without re-scanning state and
 *  without risking cross-project taskFile substring collisions. */
export interface CollisionPayload {
  kind: 'collision';
  ticketSlug: string;
  existingDirs: string[];
  priorRunIds: string[];
  /** Pre-resolved owner run id per colliding dir. Absent on legacy decisions —
   *  UI should fall back to its own state scan when this field is missing. */
  dirOwners?: Record<string, string>;
}

export interface ReviewContinuationPayload {
  kind: 'review_continuation';
  recommendedActionId: string;
  prior: RepeatReviewContext;
  fullLiveAvailable: boolean;
}

/** One human-gated skill-antipattern draft routed from a DOMAIN learning entry.
 * Farmslot never writes to the skills repo — the draft carries the exact text
 * and target path for a human to open as a PR there (MANUAL-000075). */
export interface LearningsAntipatternDraft {
  /** Stable slug identifying the antipattern (also the target file name). */
  id: string;
  /** Skills-repo-relative path, e.g. domains/agentic/skills/recipe-pr-qa-review/references/antipatterns/<repo-key>/<slug>.md */
  targetPath: string;
  symptom: string;
  cause: string;
  action: string;
  /** The original learnings.md bullet this draft was derived from. */
  sourceEntry: string;
}

/** A learning entry the router refused to guess about — visible, never dropped. */
export interface LearningsHold {
  entry: string;
  reason: string;
}

export type LearningsDraftReceipt =
  | { status: 'appended'; packageId: string; appendedAt: string }
  | { status: 'already-processed'; packageId: string }
  | { status: 'skipped'; reason: string };

export interface LearningsDraftPayload {
  kind: 'learnings-draft';
  project: string;
  sourceRunId: string;
  drafts: LearningsAntipatternDraft[];
  holds: LearningsHold[];
  /** Inbox processed.jsonl outcome when a captured package correlates to the run. */
  receipt?: LearningsDraftReceipt;
}

export type RunDecisionPayload =
  | ReviewGatePayload
  | ReadyGatePayload
  | NoChangeGatePayload
  | SlotPickerPayload
  | BranchAffinityNudgePayload
  | ImprovementDiffPayload
  | LearningsDraftPayload
  | RetrospectivePayload
  | CollisionPayload
  | ReviewContinuationPayload;

export interface RunDecision {
  id: string;
  type: DecisionType;
  title: string;
  description: string;
  actions: DecisionAction[];
  createdAt: string;
  resolvedAt?: string;
  resolvedAction?: string;
  payload?: RunDecisionPayload;
  selectionData?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

/** A single ticket referenced by a PR (linked from PR body, commit trailers, etc.) */
export interface LinkedTicket {
  ref: string; // "PROJ-2863" or "owner/repo#123"
  url: string; // Deep link (Jira browse URL, GitHub issue URL)
  title: string; // Ticket title (empty if fetch failed)
  description: string; // Full description (empty if fetch failed)
  source: 'jira' | 'github';
}

/** GitHub merge/integration signals for review-pr TASK context (informational). */
export interface PrIntegrationStatus {
  mergeable?: string;
  mergeStateStatus?: string;
  /** Operator/worker-facing summary — not a prepare gate. */
  note?: string;
}

export interface RunTicketData {
  source: 'jira' | 'github' | 'both' | 'manual';
  issueType?: string; // Jira issue type: Bug, Task, Story, etc.
  title: string;
  description: string;
  acceptanceCriteria: string[];
  affectedArea: string;
  stepsToReproduce: string[];
  screenshots: string[];
  labels: string[];
  jiraKey?: string;
  githubIssue?: string;
  comments?: string[]; // Last 10 Jira comments, "Author (date): text" format
  /**
   * Tickets referenced by a PR (review-pr flow only).
   * Multiple keys are supported — PRs often fix several tickets at once.
   * Each entry is pre-fetched from its source so templates can render without
   * extra round-trips.
   */
  linkedTickets?: LinkedTicket[];
  /** GitHub merge state for review-pr — surfaced in TASK.md, never blocks prepare. */
  prIntegration?: PrIntegrationStatus;
}

export interface RunGrade {
  difficulty: 'low' | 'medium' | 'high' | 'extreme';
  rationale: string;
  modelRecommendation: string;
  score?: number;
}

export interface ProofTargetVerdict {
  id: string;
  target: string;
  verdict: 'pass' | 'fail' | 'not-applicable';
  note?: string;
}

export interface HumanGrade {
  recipe_semantic: 'good' | 'ok' | 'bad';
  reasoning: string;
  graded_by: string;
  graded_at: string;
  proof_target_verdicts?: ProofTargetVerdict[];
}

export const DEFAULT_GRADER_ID = 'unknown';

export type RunFamilyCompletionState = 'active' | 'complete' | 'failed' | 'mixed';
export type RunSelfLearningEligibilityState = 'eligible' | 'blocked' | 'unknown';

export const RUN_SELF_LEARNING_MISSING_SIGNALS = [
  'missing-evidence-signal',
  'missing-learnings-signal',
  'missing-recipe-signal',
  'missing-diff-signal',
] as const;
export type RunSelfLearningMissingSignal = (typeof RUN_SELF_LEARNING_MISSING_SIGNALS)[number];

export const RUN_SELF_LEARNING_BLOCK_REASONS = [
  'active-runs',
  'pending-decisions',
  'no-successful-run',
] as const;
export type RunSelfLearningBlockReason = (typeof RUN_SELF_LEARNING_BLOCK_REASONS)[number];

export interface RunSelfLearningEligibility {
  state: RunSelfLearningEligibilityState;
  reasons: RunSelfLearningBlockReason[];
  missingSignals: RunSelfLearningMissingSignal[];
}

export interface RunFamilyReadinessSummary {
  familyId: string;
  familyRootTicketOrPr: string;
  project: string;
  latestRunId: string;
  latestRunAt: string;
  runCount: number;
  terminalRunCount: number;
  activeRunCount: number;
  failedRunCount: number;
  completionPercent: number;
  completionState: RunFamilyCompletionState;
  eligibility: RunSelfLearningEligibility;
}

export interface RunProjectAnalyticsSummary {
  project: string;
  familyCount: number;
  runCount: number;
  activeFamilyCount: number;
  completedFamilyCount: number;
  eligibleFamilyCount: number;
  blockedFamilyCount: number;
  unknownFamilyCount: number;
  latestRunAt: string;
}

export interface RunListSummaryMeta {
  /** First PR summaries describe only the runs returned in this run.list response after filters, sorting, and limit. */
  scope: 'returned-runs';
  /** Number of returned runs used to compute family/project summaries. */
  summaryRunCount: number;
  /** Matching run count before run.list limit truncation; mirrors RunListResult.totalCount. */
  totalCount: number;
  /** True when the returned-run summary is a partial view of the matching result set. */
  isTruncated: boolean;
}

export interface RunMetrics {
  durationMs?: number;
  nudgeCount: number;
  /** ADR-032 Phase 1: tmux nudges that timed out waiting for runner busy-clear. */
  nudgeTimeoutCount?: number;
  model: string | null;
  runner: string | null;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
  /**
   * Operator-local provider subscription label that actually funded this run
   * (after any in-place failover). Label only — never an email, token, or home path.
   */
  providerAccountLabel?: string | null;
  outcome?: 'success' | 'failure' | 'partial' | 'cancelled';
  disposition?: WorkerTerminalDisposition;
  terminalEvidence?: WorkerTerminalEvidence;
  /** Per-step checklist timing from the worker's SIGNAL.json, persisted at finalize so it survives task-dir pruning. */
  checklistTiming?: WorkerSignalChecklistTiming;
  costEstimate?: number;
  // Session-truth fields populated from the worker's transcript via session-usage.sh.
  // Help diagnose cost anomalies (e.g. dispatched sonnet but fast-mode forced opus).
  sessionTurns?: number;
  sessionInputTokens?: number;
  sessionOutputTokens?: number;
  sessionCacheCreation?: number;
  sessionCacheRead?: number;
  sessionTotalTokens?: number;
  /** Whether the session fields are raw transcript totals or a retained-review generation delta. */
  sessionUsageScope?: 'session-total' | 'review-generation-delta' | 'review-chain-total';
  /** Raw retained transcript total used as the next review generation's subtraction baseline. */
  reviewChainUsageTotal?: RunnerSessionUsage;
  actualModel?: string;
}

export type RunCompletionPolicy = 'default' | 'artifact-only';

export type RunStartRefSource =
  | { kind: 'manual' }
  | { kind: 'package'; packagePath: string }
  | { kind: 'merged-pr'; repo?: string; prNumber?: number }
  | { kind: 'git-ref'; repository?: string; ref?: string };

export interface RunStartRefProvenance {
  requestedRef: string;
  resolvedSha?: string;
  resolvedAt?: string;
  source?: RunStartRefSource;
}

export interface SlotRunHistoryEntry {
  runId: string;
  familyId: string;
  status: RunStatus;
  flowType: FlowType;
  ticketOrPr: string;
  summary?: string;
  project: string;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  runner: string | null;
  model: string | null;
  actualModel?: string;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
  taskFile: string | null;
  taskDir: string | null;
  artifactDir: string | null;
  /** PR opened or reviewed by this run, when known. Slot history uses this to keep historical workspace cards linkable. */
  prNumber: number | null;
  /** Best-known contribution diff summary from retained run metadata. Used by compact workspace clients without fetching the full run. */
  diffStat: DiffStat & { available: boolean };
  /** Number of retained before/after visual evidence pairs for compact slot-history clients. */
  visualPairCount: number;
  links?: RunLink[];
  runRecordPath: string;
  currentForSlot: boolean;
}

export type WorkerTerminalDisposition =
  | 'fixed'
  | 'already_fixed'
  | 'not_reproducible'
  | 'blocked'
  | 'failed';

export interface WorkerTerminalEvidence {
  reportPath?: string;
  artifacts?: string[];
  confidence?: 'low' | 'medium' | 'high';
}

/**
 * Compare the dispatched model short-name (e.g. "sonnet") against the actual
 * model reported by the worker's session transcript (e.g. "claude-sonnet-4-6").
 * Returns true if they refer to the same family. Used to detect model drift
 * caused by fast-mode / `/model` sticky config overriding the --model flag.
 */
export function modelsMatch(
  dispatched: string | null | undefined,
  actual: string | null | undefined,
): boolean {
  if (!dispatched || !actual) return true;
  const d = dispatched.toLowerCase();
  const a = actual.toLowerCase();
  if (d === a) return true;
  if (a.includes(d)) return true;
  const aliases: Record<string, string> = {
    sonnet: 'claude-sonnet',
    opus: 'claude-opus',
    haiku: 'claude-haiku',
  };
  const prefix = aliases[d];
  return prefix ? a.startsWith(prefix) : false;
}

/**
 * Tag a comparison-lane sibling with a `<runner>-<safe(model)>` variant so
 * the duplicate-run guard (assertDuplicateRunAllowed in run.ts) sees it as
 * distinct from any existing sibling in the family. The format is shared
 * between the dispatch wizard's submit handler and run-detail's "Re-run
 * alongside" href builder — keeping it in protocol prevents the two from
 * silently drifting apart, which would let the duplicate guard reject runs
 * that were supposed to be valid forks.
 *
 * Returns an empty string when either input is falsy so callers can keep a
 * fallback to URL-prefilled values without crashing on partial state.
 */
export function buildComparisonVariant(
  runner: string | null | undefined,
  model: string | null | undefined,
): string {
  if (!runner || !model) return '';
  const safeModel = model
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // An all-punct model (e.g. '!!!') sanitizes to '', and `${runner}-` would
  // leave a stray trailing dash that downstream URL/shell consumers don't
  // expect. Returning '' lets callers omit the variant param entirely instead
  // of producing a malformed tag the duplicate-run guard would have to parse.
  if (!safeModel) return '';
  return `${runner}-${safeModel}`;
}

/**
 * Pick the next free comparison-lane variant tag for a (runner, model) pair
 * within a family. Returns `buildComparisonVariant(runner, model)` when no
 * sibling already uses that tag; otherwise appends `-v2`, `-v3`, … until a
 * free slot is found. Used by the dispatch wizard's same-runner+same-model
 * comparison flow (e.g. operator edited templates and wants to re-run with
 * the same model) so the duplicate-run guard at run.ts:assertDuplicateRunAllowed
 * accepts the new sibling.
 */
export function nextFreeComparisonVariant(
  familyRuns: ReadonlyArray<{ variant?: string | null }>,
  runner: string | null | undefined,
  model: string | null | undefined,
): string {
  const base = buildComparisonVariant(runner, model);
  if (!base) return '';
  const taken = new Set<string>();
  for (const run of familyRuns) {
    const v = run.variant ?? '';
    if (v) taken.add(v);
  }
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-v${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Practically unreachable — 998 same-runner+same-model siblings of one ticket
  // would be a runaway. Return '' so callers (the dispatch wizard) treat it as "no
  // free variant" via isVariantInputBlocked instead of crashing the Lit render tick.
  return '';
}

/** Incremental/cached session-usage sample for soft turn/token budgets. */
export interface RunMonitorBudgetUsageState {
  path: string | null;
  size: number;
  mtimeMs: number;
  offset: number;
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  sampledAt?: string;
  unavailableReason?: string;
  /** Persistent fail-closed reason when bounded parsing loses accounting integrity. */
  integrityFailureReason?: string;
  /** True while advancing past a record larger than the bounded read window. */
  skippingOversizedRecord?: boolean;
  /** Count of records skipped for exceeding the window (their usage is uncounted). */
  skippedOversizedRecords?: number;
  /**
   * Last session-total reading for runners that restate totals rather than reporting
   * per-record usage (codex). Zeros mean counting from the start of the transcript;
   * absent means counting started at a byte offset, so the next reading only sets the
   * reference.
   */
  lastCumulative?: { input: number; output: number; cacheRead: number; total: number };
  /** Discard the next complete record: it is the previous writer's in-flight record. */
  discardNextRecord?: boolean;
  /** Filesystem identity of the counted transcript; path equality is not identity. */
  fileId?: string;
  /**
   * True once counting has been deliberately anchored at a byte offset (a warm-handoff
   * pin). Providers report increments, so there is no total to subtract.
   */
  baselineCaptured?: boolean;
  /** Legacy: parent totals the pre-increment guard subtracted. Migrated on restore. */
  baselineTurns?: number;
  baselineTotalTokens?: number;
}

/** Persisted form of the budget guard's delivery state machine. */
export interface RunBudgetDeliveryState {
  phase: 'ok' | 'breach-pending' | 'delivered' | 'abandoned' | 'unenforceable';
  pendingMessage: string | null;
  operatorMessage: string | null;
  attempts: number;
  firstHeldAt?: number;
}

export interface RunMonitorState {
  nudgeCount: number;
  lastPollAt: string;
  startedAt: string;
  lastPaneHash?: string;
  /** ISO time of last structured runner progress; used to restore stuck clocks. */
  lastStructuredProgressAt?: string;
  /** True after a one-shot usage-budget warning was emitted for this monitor session. */
  budgetWarned?: boolean;
  /** True after a budget nudge was confirmed delivered (may retry while false). */
  budgetNudgeSent?: boolean;
  /**
   * Delivery attempts made for the budget nudge. Retries stop at
   * MAX_BUDGET_NUDGE_ATTEMPTS so an unconfirmable pane cannot accumulate copies
   * of the warning in the runner composer.
   */
  budgetNudgeAttempts?: number;
  /** Epoch ms of the first mid-turn deferral of a pending budget warning. */
  budgetFirstDeferredAt?: number;
  /** The budget guard's delivery state. Supersedes the flags below. */
  budgetDelivery?: RunBudgetDeliveryState;
  /** Append-only transcript sample cache for the soft budget guard. */
  budgetUsage?: RunMonitorBudgetUsageState;
}

export interface RunLink {
  label: string; // e.g. "Jira", "PR", "Issue"
  url: string;
}

export type RunAutoRecoveryProposalStatus =
  | 'idle'
  | 'manual-in-progress'
  | 'auto-in-progress'
  | 'disabled';
export interface RunRecoveryRuntimeProposal {
  status: RunAutoRecoveryProposalStatus;
  proposalId?: string;
  generation: number;
}

export interface RunReplayStep {
  id: string;
  attempt: number;
  stepName: string;
  startedAt: string;
  completedAt?: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  triggeredBy: 'auto-recovery' | 'operator';
  intelligenceActionId?: string;
}

export const INTELLIGENCE_ACTION_ACTORS = ['auto-recovery', 'auto-grade', 'auto-nudge'] as const;
export type IntelligenceActionActor = (typeof INTELLIGENCE_ACTION_ACTORS)[number];
export const INTELLIGENCE_ACTION_TIERS = ['deterministic', 'llm-refined', 'hybrid'] as const;
export type IntelligenceActionTier = (typeof INTELLIGENCE_ACTION_TIERS)[number];
export const INTELLIGENCE_ACTION_OUTCOMES = ['applied', 'proposed', 'skipped', 'errored'] as const;
export type IntelligenceActionOutcome = (typeof INTELLIGENCE_ACTION_OUTCOMES)[number];
export const INTELLIGENCE_ACTION_OUTCOME_REASONS = [
  'max_attempts_per_step',
  'family_cap',
  'cooldown_active',
  'non_recoverable_category',
  'low_confidence',
  'budget_exceeded',
  'pattern_disabled',
  'manual_in_progress',
  'dead_letter',
] as const;
export type IntelligenceActionOutcomeReason = (typeof INTELLIGENCE_ACTION_OUTCOME_REASONS)[number];
export const INTELLIGENCE_ACTION_FOLLOWUPS = [
  'recovered',
  'failed-again',
  'human-overrode',
  'cancelled',
] as const;
export type IntelligenceActionFollowup = (typeof INTELLIGENCE_ACTION_FOLLOWUPS)[number];
export const INTELLIGENCE_ACTION_PROPOSED_TYPES = [
  'run.replayStep',
  'slot.reset',
  'slot.cleanupProcesses',
  'slot.fixtureRefresh',
  'tmux.send',
] as const;
export type IntelligenceActionProposedType = (typeof INTELLIGENCE_ACTION_PROPOSED_TYPES)[number];
export interface IntelligenceActionGuard {
  name: string;
  passed: boolean;
  reason?: string;
}
export interface IntelligenceAction {
  id: string;
  timestamp: string;
  decidedAt: string;
  runId: string;
  familyId?: string;
  project?: string;
  stepName?: string;
  actor: IntelligenceActionActor;
  verdict: {
    category?: FailureCategory;
    patternId?: string;
    confidence: RunRecoveryProposalConfidence;
    rationale?: string;
  };
  guards: IntelligenceActionGuard[];
  outcome: IntelligenceActionOutcome;
  outcomeReason?: IntelligenceActionOutcomeReason;
  latencyMs?: number;
  appliedAction?: {
    type: IntelligenceActionProposedType;
    stepName?: string;
    replayRunId?: string;
    tmuxKeys?: string;
  };
  followupOutcome?: IntelligenceActionFollowup;
  tier: IntelligenceActionTier;
  costUsd: number;
}
export interface IntelligenceActionsSummary {
  /** Count of records after date filtering; independent from the returned page size. */
  total: number;
  byActor: Record<string, number>;
  byOutcome: Record<string, number>;
  /** Most recent records after date filtering, capped by request limit. */
  records: IntelligenceAction[];
  metadata: { parseFailures: number; shapeDriftFailures: number };
}

export const RUN_TAG_MAX_COUNT = 20;
export const RUN_TAG_MAX_LENGTH = 40;

export function normalizeRunTag(value: string): string {
  return value
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, RUN_TAG_MAX_LENGTH);
}

export function normalizeRunTags(values: readonly string[] | undefined | null): string[] {
  if (!values?.length) return [];
  const tags = new Set<string>();
  for (const raw of values) {
    const tag = normalizeRunTag(String(raw));
    if (tag) tags.add(tag);
    if (tags.size >= RUN_TAG_MAX_COUNT) break;
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/**
 * The single contract for domain overlay names. A domain name lands in
 * fixture paths, sed replacement text (sync-fixtures.sh, which enforces the
 * same rule shell-side), and worker-template variant file names — so it is a
 * lowercase slug with no separators, no sed metacharacters, and no
 * leading/trailing punctuation. Validate at the entry point with
 * isValidDomainName; reject, never sanitize.
 */
export const DOMAIN_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function isValidDomainName(value: string): boolean {
  return DOMAIN_NAME_RE.test(value);
}

// ─── Machine pause / park lifecycle ───

export type MachinePauseMode = 'orchestration' | 'release';

/** Durable checkpoints used to resume an interrupted park/restore operation. */
export type MachineParkPhase =
  | 'intent-persisted'
  | 'orchestration-pausing'
  | 'orchestration-paused'
  | 'runner-stopping'
  | 'runner-stopped'
  | 'resources-stopping'
  | 'parked'
  | 'resources-restoring'
  | 'runner-reloading'
  | 'orchestration-resuming'
  | 'restored'
  | 'cancelling'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type MachineParkResourcePhase =
  | 'observed-running'
  | 'stopping'
  | 'stopped'
  /** Left running on purpose because the catalog says releasing never stops it, and verified still running at settle. */
  | 'retained'
  | 'restoring'
  | 'restored'
  | 'failed';

export type MachineParkCapabilityLeaseState =
  | 'held'
  | 'releasing'
  | 'released'
  | 'reacquiring'
  | 'reacquired'
  | 'failed';

export interface MachineParkCapabilityLease {
  leaseId: string;
  /** Lease created when restore reacquires this capability; differs from the released lease id. */
  restoredLeaseId?: string;
  capabilityId: string;
  state: MachineParkCapabilityLeaseState;
  parameters: Record<string, unknown>;
  proofRequirement: RuntimeCapabilityProofRequirement;
  ownerFamilyId?: string;
  /** Optional provider-resource association; leases remain first-class manifest entries. */
  resourceId?: string;
  error?: string;
}

/** Parking's factual disposition for one manifest resource. */
export type MachineParkResourceReleaseEffect = 'stop' | 'retain';

/** One resource that was observed running when release-pause intent was captured. */
export interface MachineParkResource {
  resourceId: string;
  label: string;
  type: ResourceType;
  observedStatus: 'running';
  phase: MachineParkResourcePhase;
  /**
   * What parking does to this resource, resolved from the project catalog's
   * affected-resource metadata. `stop` shuts it down and restore boots it back;
   * `retain` leaves it running and restore only verifies it never stopped.
   * Absent on records journalled before the metadata existed; read it as `stop`.
   */
  releaseEffect?: MachineParkResourceReleaseEffect;
  capabilityLeaseIds: string[];
  stoppedAt?: string;
  restoredAt?: string;
  error?: string;
}

/** What restore did to one resource, emitted by the code path that did it. */
export type MachineParkRestoreAction = 'verified' | 'booted' | 'stopped' | 'skipped';

/**
 * One lifecycle effect a restore performed, recorded as fact rather than
 * inferred from the absence of an error. A successful boot leaves no error
 * behind, so "no boot error" can never prove no boot happened; this can.
 */
export interface MachineParkRestoreEffect {
  resourceId: string;
  action: MachineParkRestoreAction;
  /** Gateway clock, when the effect was performed or observed. */
  at: string;
  /** False when the action failed, or when it happened and should not have. */
  ok: boolean;
  reason?: string;
}

export interface MachineParkResourceManifest {
  capturedAt: string;
  resources: MachineParkResource[];
  capabilityLeases: MachineParkCapabilityLease[];
}

/** Exact persisted runner identity required to restore a released worker. */
export interface MachinePauseRecoveryHandle {
  version: 1;
  runnerId: string;
  contextId: string;
  sessionId: string;
  sessionPath: string;
  target: AgentContextTarget & { paneId: string };
  model: string | null;
  effort?: string | null;
  safetyTier?: SafetyTier;
  runtimeDir?: string;
  taskDir?: string;
  capturedAt: string;
}

export interface MachineParkError {
  phase: MachineParkPhase;
  action: string;
  code: string;
  message: string;
  occurredAt: string;
  retryable: boolean;
  resourceId?: string;
}

export type MachineParkResidualState = 'running' | 'stopped' | 'unknown';

export interface MachineParkResiduals {
  runner: MachineParkResidualState;
  resources: Array<{
    resourceId: string;
    state: MachineParkResidualState;
    detail?: string;
  }>;
}

export interface MachineParkCurrentStep {
  index: number;
  name: string;
  status: RunStepStatus;
}

/**
 * What a release-mode park does with the run's slot.
 *
 * `retained` keeps the slot bound to the parked run (machine-wide pause of a
 * monitoring or CI-watching run). `freed` releases slot ownership so dispatch
 * can select it while the run stays parked at its operator wait — the park
 * record, not the slot row, is then the authority for the run's slot binding.
 * Absent on records written before slot freeing existed; treat as `retained`.
 */
export type MachineParkSlotDisposition = 'retained' | 'freed';

/**
 * Machine-pause eligibility codes that clients and the Gateway share. Every
 * other code stays private to the Gateway verdict; these are the gate-park
 * contract added by the free-slot-at-an-operator-wait decision.
 */
export const MachineParkEligibilityCodes = {
  /** A gate-held publication run may be released and its slot freed. */
  eligibleGateRelease: 'ELIGIBLE_GATE_RELEASE_PAUSE',
  /** The run's runner declares no graceful stop plus persisted session reload. */
  runnerReloadUnsupported: 'RUNNER_RELOAD_UNSUPPORTED',
  /** A gate-held run can only be parked in release mode; orchestration-only would strand its gate. */
  gateParkRequiresRelease: 'GATE_PARK_REQUIRES_RELEASE',
  /**
   * The record freed its slot, so the operation asked for cannot act on the
   * run until a restore has put it back. Not a refusal of restore itself:
   * `machine.pause.restore` and gate resolution both drive that restore.
   */
  freedSlotRestoreRequired: 'FREED_SLOT_RESTORE_REQUIRED',
  /**
   * Restore refused: the original slot is no longer free. The record stays
   * parked and its decision stays pending, so the run can be restored later or
   * cancelled. Cross-slot re-dispatch is a separate decision.
   */
  restoreSlotTaken: 'RESTORE_SLOT_TAKEN',
  /**
   * Restore refused: the preserved branch cannot be checked back out — the
   * successor left uncommitted work in the tree, or the branch no longer sits
   * at the tip the park detached from.
   */
  restoreWorkspaceUnavailable: 'RESTORE_WORKSPACE_UNAVAILABLE',
  /**
   * Restore refused: the persisted runner session could not be reloaded with a
   * structured acknowledgement, so nothing may claim the worker is back.
   */
  restoreRunnerReloadFailed: 'RESTORE_RUNNER_RELOAD_FAILED',
  /**
   * The restore had to re-present the gate because its engine loop had exited,
   * so the decision the operator answered is no longer the live one.
   */
  restoreGateReplayed: 'RESTORE_GATE_REPLAYED',
  /**
   * Freeing the slot would expose the run's workspace to the next occupant's
   * prepare, and its branch tip could not be preserved first.
   */
  workspaceNotPreservable: 'WORKSPACE_NOT_PRESERVABLE',
  /** A gate park is in flight for this run; its gate cannot be resolved yet. */
  gateParkInFlight: 'GATE_PARK_IN_FLIGHT',
} as const;

export type MachineParkEligibilityCode =
  (typeof MachineParkEligibilityCodes)[keyof typeof MachineParkEligibilityCodes];

/**
 * The git identity a freeing park took out of the slot's working tree.
 *
 * A linked worktree keeps the parked run's branch checked out, and the next
 * occupant's prepare resets the checked-out branch to its base ref — which
 * would move the parked branch and discard its commits. The park detaches HEAD
 * first and records what it detached from, so the branch ref survives at
 * `headSha` and restore can check it out again.
 */
export interface MachineParkWorkspace {
  branch: string;
  headSha: string;
  /**
   * When the detach actually landed, not when it was planned. Absent means the
   * branch is still checked out in the slot, so the park had no workspace
   * effect yet. Same fact-versus-intent split as `slotFreedAt`.
   */
  detachedAt?: string;
}

/**
 * The stages a freed-slot restore owes, in the order it owes them.
 *
 * Tracked as its own sequence rather than inferred from what the record happens
 * to look like. Occupancy, the detached branch, the lease states, and the
 * runner proof each record ONE stage's outcome, so reading them as a whole is a
 * guess: a restore that re-bound the slot and then died before re-creating the
 * pane looks, to an occupancy reader, exactly like a restore that never had to
 * touch the slot at all — and the retry then takes the ordinary path and fails
 * on a recovery handle nothing re-hosted.
 */
export const MACHINE_PARK_RESTORE_STAGES = [
  /** The slot row is bound to the run again. */
  'rebind',
  /** The preserved branch is back in the working tree at its recorded tip. */
  'reattach',
  /** Manifest capabilities and resources are held and running again. */
  'reacquire',
  /** The worker is back on its persisted session, and both attach targets say where. */
  'reload',
] as const;

export type MachineParkRestoreStage = (typeof MACHINE_PARK_RESTORE_STAGES)[number];

/**
 * How far the current restore attempt got, written around each stage.
 *
 * `attempting` is written BEFORE the stage runs and `completed` only after it
 * lands, so a crash anywhere inside a stage is visible as an unfinished stage
 * rather than as an absence. The write-ahead journal is kept until every stage
 * is in `completed`.
 */
export interface MachineParkRestoreProgress {
  /** The restore operation these stages belong to; a newer one starts over. */
  operationId: string;
  /** The stage currently being attempted, if any. Cleared when it completes. */
  attempting?: MachineParkRestoreStage;
  /** Stages proven complete, in the order they landed. */
  completed: MachineParkRestoreStage[];
  updatedAt: string;
}

/** Whether every stage a freed-slot restore owes has landed. */
export function machineParkRestoreComplete(
  progress: MachineParkRestoreProgress | undefined,
): boolean {
  if (!progress || progress.attempting) return false;
  return MACHINE_PARK_RESTORE_STAGES.every((stage) => progress.completed.includes(stage));
}

/**
 * Why the last restore attempt refused, kept on the record so a reconnecting
 * client sees the reason without replaying the RPC that produced it.
 *
 * A refusal is not a failure of the park: the record stays `parked`, its
 * decision stays pending, and the run can be restored again later or
 * cancelled. Cleared the moment a restore gets past the refusal.
 */
export interface MachineParkRestoreRefusal {
  /** A `MachineParkEligibilityCode`; carried as a string like every verdict code. */
  code: string;
  reason: string;
  at: string;
}

/** Write-ahead per-run record; persisted on Run before any release side effect. */
export interface MachineParkRecord {
  version: 1;
  operationId: string;
  previewId: string;
  runId: string;
  generation: number;
  restoredGeneration?: number;
  machine: string;
  slotId: string;
  mode: MachinePauseMode;
  phase: MachineParkPhase;
  prePauseStatus: RunStatus;
  prePauseCurrentStep: MachineParkCurrentStep | null;
  resourceManifest: MachineParkResourceManifest;
  recoveryHandle: MachinePauseRecoveryHandle | null;
  /** Slot intent decided at preview; absent means `retained`. */
  slotDisposition?: MachineParkSlotDisposition;
  /**
   * The workspace a freeing park detached, so the next occupant's prepare
   * cannot reset the parked run's branch. Written before slot ownership is
   * released; `restore` checks the branch back out at this exact tip.
   */
  preservedWorkspace?: MachineParkWorkspace;
  /**
   * When slot ownership was actually released, not merely intended. Set only
   * after the park stopped the runner and every manifest resource, so a partial
   * park never advertises a freed slot.
   *
   * Kept for the whole restore and cleared only when every restore stage has
   * landed, so it stays the marker of "this record owes a freed-slot restore".
   * OCCUPANCY is `slotReboundAt`, which lands earlier: the two are deliberately
   * separate, because a restore that re-bound the slot and then failed still
   * owes the rest of its stages.
   */
  slotFreedAt?: string;
  /**
   * When a restore re-bound the freed slot to this run, not merely intended
   * to. Written in the same write-ahead window that clears `slotFreedAt`, so a
   * crash between the slot claim and the record write is repairable. Survives
   * the restore as the note that this record's slot came back.
   */
  slotReboundAt?: string;
  /**
   * How far the current restore attempt got. Absent until a freed-slot restore
   * starts, and the authority for what a retry still owes — never inferred from
   * whether the run currently occupies its slot.
   */
  restoreProgress?: MachineParkRestoreProgress;
  /**
   * Why the last restore attempt refused, when it refused without changing
   * anything. Absent once a restore gets past the refusal.
   */
  restoreRefusal?: MachineParkRestoreRefusal;
  /** Restore intent classification persisted before any selected batch member mutates. */
  restoreDisposition?: 'zero-effect' | 'effectful';
  /**
   * What the last restore attempt actually did to each manifest resource, in
   * the order it did it. Reset at the start of each attempt. Absent on records
   * written before restore recorded its effects.
   */
  restoreEffects?: MachineParkRestoreEffect[];
  /** Exact runner-native acknowledgement captured before orchestration resumes. */
  recoveryProof?: {
    sessionId: string;
    live: true;
    acknowledgement: {
      kind: 'structured';
      source: string;
      reason: string;
      turnToken?: string;
    };
    acceptedAt: string;
  };
  errors: MachineParkError[];
  residuals: MachineParkResiduals;
  createdAt: string;
  updatedAt: string;
  parkedAt?: string;
  restoredAt?: string;
  cancelledAt?: string;
}

export interface Run {
  id: string;
  familyId: string;
  parentRunId?: string | null;
  familyRootTicketOrPr?: string;
  /** Run policy bucket: production, validation, or comparison. Not a flow type and not an eval identity. */
  lane: RunLane;
  /** Required only for comparison-lane sibling attempts; never a mode. */
  variant?: string | null;
  /** Selected project-owned worker template version for this run. */
  taskTemplate?: TaskTemplateSelection;
  /** Exact shared-catalog template id requested for this run. */
  executionTemplateId?: string;
  /** Portable snapshot selected and revalidated by the gateway. */
  executionTemplate?: import('./execution-templates.js').ExecutionTemplateReference;
  /** Worker pipeline/template carrier. Eval candidates may use dev as a carrier while taskProfile stores rubric semantics. */
  flowType: FlowType;
  /** Operator/autonomy behavior preset. mode='validation' implies lane='validation' and is not used for comparison siblings. */
  mode?: 'interactive' | 'autonomous' | 'validation';
  /** Dev-only interactive policy. Keeps flowType='dev' while allowing flexible human-steered runs. */
  devInteractiveProfile?: DevInteractiveProfile;
  status: RunStatus;
  project: string;
  ticketOrPr: string;
  app?: string;
  /**
   * Named domain overlay carried by this run. Free-form and project-defined —
   * threaded into prepare/fixture sync as the `DOMAIN` compose variable and
   * the `{{domain}}` template placeholder.
   */
  domain?: string;
  /** Named prepare profile requested for this run (ADR-037). */
  prepareProfile?: string;
  /**
   * Dispatch-time resource posture preset (ADR-054). Presets the gate choice for
   * every durable operator wait of this run; an explicit gate choice still wins.
   */
  waitPolicy?: ResourcePostureWaitPolicy;
  /**
   * Branch-update strategy for `update-branch` runs (rebase | merge |
   * project-default). Ignored for other flows. Rendered into the worker task
   * as the `BRANCH_UPDATE_STRATEGY` template var (see tasks/writer.ts); the
   * worker applies it. `project-default` defers to project policy at runtime.
   * (Distinct from the prepare-time ADR-042 `merge_main_strategy`.)
   */
  branchUpdateStrategy?: BranchUpdateStrategy;
  effort?: string;
  /** Worker scripted-runner config when metrics.runner='scripted'. */
  scripted?: ScriptedRunnerConfig;
  slotId: string | null;
  branch: string | null;
  /** Completion side-effect policy; artifact-only suppresses publication/PR mutation paths. */
  completionPolicy?: RunCompletionPolicy;
  /** Principal-stamped one-dispatch pressure override requested for this run.
   * Bound to one machine + pressure generation; dispatch execution recomputes
   * the admission decision and rejects the override when the generation moved. */
  pressureOverride?: import('./pressure-admission.js').PressureOverrideAudit;
  /** Preview identity of the admitted pressure decision this run was created
   * against (client-rendered preview, or FIND_SLOT's selected decision for
   * automatic runs). Execution rejects with PRESSURE_PREVIEW_STALE when it no
   * longer matches freshly recomputed evidence. */
  pressureAdmissionRef?: import('./pressure-admission.js').PressureAdmissionReference;
  /** Requested/resolved base ref for artifact-only comparison replay runs. */
  startRef?: RunStartRefProvenance | null;
  /** Gateway-captured template provenance for the rendered worker task. */
  templateProvenance?: TemplateProvenance | null;
  taskFile: string | null;
  activeTaskFile?: string; // currently active task md (TASK.md, SELF-REVIEW.md, SELF-REVIEW-FIX.md)
  agentContexts?: AgentContext[];
  prNumber?: number;
  /**
   * Merge outcome for `prNumber`, recorded by ci-watch when it observes the PR
   * reach a terminal state. Work-graph `merged` edges gate on this: without a
   * persisted observation, a downstream node can never learn that its upstream
   * shipped, because the observation itself lives only inside the CI monitor.
   */
  prState?: 'OPEN' | 'CLOSED' | 'MERGED';
  /** ISO timestamp GitHub reports for the merge; absent unless prState is MERGED. */
  mergedAt?: string | null;
  steps: RunStep[];
  decisions: RunDecision[];
  metrics: RunMetrics;
  createdAt: string;
  /** Timestamp when the supervised run lifecycle started. */
  startedAt?: string;
  updatedAt: string;
  /** Present on archived run records so archive-aware readers can suppress them from active timelines. */
  archivedAt?: string;
  ticketData?: RunTicketData;
  grade?: RunGrade;
  humanGrade?: HumanGrade;
  links?: RunLink[];
  /** Operator-curated labels for demo/review collections. Normalized with normalizeRunTags. */
  tags?: string[];
  summary?: string; // LLM-generated 1-line description
  reviewTier?: string; // forced tier for review-pr: '' (auto — LLM picks strategy) | 'light' (→ smoke) | 'standard' (→ smoke|targeted) | 'full' (→ targeted|full-qa)
  /** Code breadth for review-pr. Independent from runtime validation depth. */
  reviewScope?: ReviewScope;
  /** Static by default; full-live is an explicit operator escalation. */
  reviewValidationDepth?: ReviewValidationDepth;
  /** Frozen provenance for a repeated review of the same canonical PR. */
  repeatReviewContext?: RepeatReviewContext;
  safetyTier?: SafetyTier; // runner execution safety tier (ADR-023). undefined on legacy runs.
  /**
   * Slots the run is allowed to land on, resolved from the UI's global filters
   * (e.g. machines, future filter dimensions) at dispatch time. `null` = unrestricted.
   * Honored by FIND_SLOT, affinity reuse, and chained runs. Strictly narrower than
   * the project-wide pool but wider than `slotId`, which pins a single slot.
   */
  allowedSlots?: string[] | null;
  /** Internal backlog handoff link, persisted so backlog delete/reconcile can find runs. */
  backlogItemId?: string;
  /**
   * Durable write-ahead marker for an operator-requested backlog/run repair.
   * Startup clears it after the backlog projection is persisted.
   */
  backlogReconcilePending?: boolean;
  /** Work graph node that scheduled this run via backlog/queue. */
  workGraphId?: string;
  workNodeId?: string;
  /** Backlog launch-plan linkage for baseline/comparison candidate sets (ADR-044). */
  launchPlanId?: string;
  launchCandidateId?: string;
  launchGroupId?: string;
  launchSlotPolicy?: import('./backlog.js').BacklogLaunchSlotPolicy['kind'];
  /** Monotonic per-candidate launch attempt, inherited from the queue item; lets run
   * observations tell a legitimate takeover from a stale echo of a superseded run. */
  launchAttempt?: number;
  completedAt?: string;
  error?: string;
  /**
   * When set, this run was cancelled because the engine forked it into another run
   * (e.g. the collision → comparison-lane redirect at WRITE_TASK). UI surfaces this as
   * an info banner with a link to the successor instead of treating the run as a failure.
   */
  redirectedToRunId?: string | null;
  monitorState?: RunMonitorState;
  /** CI-watch inline-fix dedup + counters. Persisted so the circuit breaker survives gateway restart (ADR-027). */
  ciWatchState?: RunCiWatchState;
  /** Run-engine runtime flags + replay generation counter. Persisted so warm-recovery hints
   * and stale-loop guards survive gateway restart (ADR-027). */
  engineState?: RunEngineState;
  /** Provenance-aware live recipe context used by slot-view/dev harness surfaces. */
  liveRecipeContext?: LiveRecipeContext | null;
  recoveryAttempts?: RunReplayStep[];
  recoveryProposal?: RunRecoveryRuntimeProposal;
  autoRecoveryDisabled?: boolean;
  /**
   * Set once when the run's terminal analytics record has been written to the
   * decoupled analytics sink. Guards emit-once idempotency across the updateRun
   * hook and the archive/delete catch-alls (see runs/analytics.ts).
   */
  analyticsEmittedAt?: string;
  /** Present when this run record was imported from a portable bundle (ADR-039). */
  importProvenance?: RunImportProvenance;
  /** Durable machine-scoped pause/release/restore state. */
  park?: MachineParkRecord | null;
  /** Gateway-owned effective resource posture and last transition (ADR-054). */
  resourcePosture?: RunResourcePostureState;
  /** Imported reference-only runs must not be re-dispatched or activated on slot. */
  readOnly?: boolean;
  /** Slot HEAD SHA captured at dispatch (after prepare) — base for per-run iteration diff. */
  worktreeHeadAtDispatch?: string | null;
}

export type { RunImportProvenance } from './run-bundles.js';

export function isLightweightInteractiveDevRun(
  run: Pick<Run, 'flowType' | 'mode' | 'devInteractiveProfile'>,
): boolean {
  return isInteractiveDevRun(run) && run.devInteractiveProfile === DEFAULT_DEV_INTERACTIVE_PROFILE;
}

export function isInteractiveDevRun(run: Pick<Run, 'flowType' | 'mode'>): boolean {
  return run.flowType === 'dev' && run.mode === 'interactive';
}

/** Persisted run-engine state — see ADR-027. */
export interface RunEngineState {
  /** Runtime hints set by dispatch UI (e.g. skipPrepare) or engine (warmRecovery on crash resume).
   * `nudgeReuse` is set when the operator picks "Nudge worker" in the dispatch wizard or the
   * branch-affinity decision card; FIND_SLOT honors it to bind the busy slot, and DISPATCH
   * routes through `nudgeDispatch` (skip PREPARE, send-keys to existing tmux session) instead
   * of `dispatchExecute` (kill + relaunch). `freshReuse` replaces either that busy
   * branch-affinity worker or an unowned warm runner. FIND_SLOT hard-kills it BEFORE PREPARE
   * so git reset / checkout / dependency install don't race a still-writing worker.
   * `warmSessionReuse` is set on CI-watch chained follow-ups (pr-complete / update-branch)
   * when the parent kept its worker warm through finalize; DISPATCH tries handoff into that
   * session and falls back to fresh `dispatchExecute` when the process is dead or not nudgeable. */
  flags?: {
    skipPrepare?: boolean;
    warmRecovery?: boolean;
    nudgeReuse?: boolean;
    freshReuse?: boolean;
    /** Opt-in integrate-main during review-pr prepare (merge commit, soft-fail on conflict). */
    mergeMain?: boolean;
    /**
     * CI-watch chain handoff: attempt to reuse the parent's still-alive worker session
     * instead of killing and relaunching. Distinct from `nudgeReuse` (busy mid-task branch
     * affinity) — warm handoff targets held/ci-watch slots with an idle agent status.
     */
    warmSessionReuse?: boolean;
    /**
     * True only when DISPATCH actually handed off into the warm parent session.
     * False when warmSessionReuse was requested but fell back to fresh dispatch.
     * Soft budget baselines use this — not the request flag alone.
     */
    warmHandoffSucceeded?: boolean;
  };
  /** Monotonic replay generation counter; startRun bails if the run has been superseded. */
  generation?: number;
  /** Operator `run.forceComplete` on a failed run. Replay must not treat this as ordinary done. */
  operatorForceCompleted?: true;
  /** Multi-surface validation matrix suggested at dispatch (farmslot profile-fit). */
  validationPlan?: ValidationPlanStep[];
  profileFitSuggestion?: ProfileFitSuggestion;
  autoRecoveryDeadLetter?: string;
  intelligenceAuditDegraded?: boolean;
  /** Local-first publication gate metadata. Stored on the run JSON snapshot; no DB migration. */
  publishGate?: {
    packageId?: string;
    packageHash?: string;
    packageInputHash?: string;
    reviewSubjectHash?: string;
    packageArtifactPath?: string;
    approvedPackageHash?: string;
    approvedAt?: string;
    publicationTarget?: PublicationTarget;
    publicationStatus?: PublicationStatus;
    prNumber?: number | null;
    reviewDepth?: ReviewDepthPolicy;
    pendingReviewPlan?: ReviewLoopRequest[];
    /** Creation time for the current pending plan, used to ignore reviews from earlier work orders. */
    pendingReviewPlanRequestedAt?: string;
    independentReviews?: IndependentReviewStatus[];
    /** Latest recoverable refusal to launch a publication reviewer. */
    reviewLaunchRejection?: PublicationReviewLaunchRejection;
    supersededPackageIds?: string[];
    feedbackArtifactPath?: string;
    /** Bounded restart watcher state for an in-flight publication reviewer. */
    reviewRecovery?: {
      status: 'watching' | 'recovered' | 'operator-required';
      attempts: number;
      startedAt: string;
      updatedAt: string;
      nextRetryAt?: string;
      lastError?: string;
    };
    /** Consolidated gate narrative snapshot, persisted so historical redisplay needs no recompute. */
    gateSummary?: GateSummary;
  };
  /** Artifact-first experiment trial linkage for artifact-only reference/template regression candidates. */
  evalExperiment?: {
    /** Matrix/suite-wide cap group for eval queue accounting across per-case experiments. */
    capGroupId?: string;
    suiteId?: string;
    experimentId: string;
    experimentKey: string;
    experimentManifestPath: string;
    packagePath: string;
    candidateStrategyFingerprint: string;
    trialId: string;
  };
  /** Interactive dev operator workflow metadata and terminal action history. */
  interactiveDev?: {
    profile?: DevInteractiveProfile;
    initialContext?: string;
    checklist?: string[];
    terminalActions?: DevInteractiveActionRecord[];
  };
}

/**
 * Per-run CI-watch inline-fix state — persisted on {@link Run} so dedup signatures
 * and attempt counters survive gateway restart (ADR-027).
 */
export interface RunCiWatchState {
  /** Last successfully-dispatched fix fingerprint (bot-comment signature + HEAD sha). */
  dedup?: { signature: string; commitSha: string };
  /** When the current no-progress timeout window started. */
  timeoutWindowStartedAt?: string;
  /** Last observed progress in watched CI status or PR head. */
  lastProgressAt?: string;
  /** Human-readable reason for the last progress reset. */
  lastProgressReason?: string;
  /** Last watched-check status fingerprint used to detect progress. */
  lastCheckFingerprint?: string;
  /** Last observed local PR head SHA used to detect new commits. */
  lastHeadSha?: string | null;
  /** Consecutive-failure counter; resets on success. Gates consecutive fallback (MAX_INLINE_CI_FIX_ATTEMPTS). */
  consecutiveAttempts: number;
  /** Lifetime attempt counter; never resets. Gates hard ceiling (MAX_INLINE_CI_FIX_TOTAL). */
  totalAttempts: number;
  /** Count of dedup-filtered skips, surfaced in step outputs. */
  skips: number;
}

export type FamilyDiffProvenanceSource = 'artifact' | 'legacy-step-output' | 'unavailable';

export type FamilyDiffKind = 'contribution' | 'review-input' | 'legacy' | 'iteration';

export interface FamilyDiffProvenance {
  source: FamilyDiffProvenanceSource;
  available: boolean;
  files: number;
  additions: number;
  deletions: number;
  partialStat?: DiffStat;
  kind: FamilyDiffKind;
  filter?: 'source-code';
  artifactPath?: string;
  baseRef?: string;
  baseSha?: string;
  headRef?: string;
  headSha?: string;
  capturedAt?: string;
  configSource?: 'project' | 'gateway-default';
  configFallbackReason?: string;
  configFallbackError?: string;
  missingReason?: string;
  error?: string;
  repository?: string;
  prNumber?: number;
  reviewScope?: ReviewScope;
}

export function isFamilyDiffProvenance(value: unknown): value is FamilyDiffProvenance {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  const isCount = (candidate: unknown) =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0;
  const isOptionalString = (candidate: unknown) =>
    candidate == null || typeof candidate === 'string';
  const partial = rec.partialStat;
  const hasValidPartial =
    partial == null ||
    (typeof partial === 'object' &&
      partial !== null &&
      isCount((partial as Record<string, unknown>).files) &&
      isCount((partial as Record<string, unknown>).additions) &&
      isCount((partial as Record<string, unknown>).deletions));
  if (rec.available === true && rec.missingReason != null) return false;
  if (rec.source === 'unavailable' && rec.available !== false) return false;
  return (
    (rec.source === 'artifact' ||
      rec.source === 'legacy-step-output' ||
      rec.source === 'unavailable') &&
    (rec.kind === 'contribution' ||
      rec.kind === 'review-input' ||
      rec.kind === 'legacy' ||
      rec.kind === 'iteration') &&
    typeof rec.available === 'boolean' &&
    isCount(rec.files) &&
    isCount(rec.additions) &&
    isCount(rec.deletions) &&
    hasValidPartial &&
    isOptionalString(rec.artifactPath) &&
    isOptionalString(rec.baseRef) &&
    isOptionalString(rec.baseSha) &&
    isOptionalString(rec.headRef) &&
    isOptionalString(rec.headSha) &&
    (rec.reviewScope == null || isReviewScope(rec.reviewScope)) &&
    isOptionalString(rec.capturedAt) &&
    isOptionalString(rec.configFallbackReason) &&
    isOptionalString(rec.configFallbackError) &&
    isOptionalString(rec.missingReason) &&
    isOptionalString(rec.error) &&
    isOptionalString(rec.repository) &&
    (rec.prNumber == null || isCount(rec.prNumber))
  );
}

export interface FamilyInputCommitMetadata {
  repository?: string;
  prNumber?: number;
  baseRef?: string;
  baseSha?: string;
  headRef?: string;
  headSha?: string;
  reviewScope?: ReviewScope;
  capturedAt: string;
  source: 'github-pr' | 'local-git' | 'unavailable';
  missingReason?: string;
  error?: string;
}

export interface FamilyReviewSignalSummary {
  total: number;
  real: number;
  fixed: number;
  botAddressed: number;
  humanReviewersRequestingChanges: number;
  humanCommentsAddressed: number;
  unknownSource: number;
}

export interface FamilyArtifactBucketSummary {
  key: string;
  count: number;
  bytes: number;
}

export interface FamilyArtifactFootprint {
  count: number;
  bytes: number;
  byPurpose: FamilyArtifactBucketSummary[];
  bySource: FamilyArtifactBucketSummary[];
  byExtension: FamilyArtifactBucketSummary[];
}

export interface FamilyObservabilityArtifact {
  runId: string;
  familyId: string;
  sourceRunId?: string;
  sourceFamilyId?: string;
  stepName?: string | null;
  path: string;
  purpose: string;
  sha256?: string;
  sizeBytes?: number;
  maxFps?: number;
  source:
    | 'artifact-manifest'
    | 'step-output'
    | 'task-artifact'
    | 'task-input'
    | 'inherited-context'
    | 'recovered-provenance';
}

export interface FamilyChangeLedgerEntry {
  runId: string;
  familyId: string;
  parentRunId?: string | null;
  familyRootTicketOrPr: string;
  lane: RunLane;
  variant?: string | null;
  flowType: FlowType;
  project: string;
  ticketOrPr: string;
  branch: string | null;
  prNumber: number | null;
  createdAt: string;
  completedAt?: string;
  changeKind: 'contribution' | 'review-input' | 'follow-up' | 'legacy' | 'none';
  contributionDiff: FamilyDiffProvenance;
  /** Code delta produced during this run only (dispatch HEAD → complete HEAD). */
  iterationDiff?: FamilyDiffProvenance;
  inputDiff?: FamilyDiffProvenance;
  legacyDiffFallback?: FamilyDiffProvenance;
  inputCommit?: FamilyInputCommitMetadata;
  reviewSignals?: FamilyReviewSignalSummary;
  artifactFootprint: FamilyArtifactFootprint;
  taskInputArtifacts: FamilyObservabilityArtifact[];
  missingData: string[];
}

export interface FamilyChangeLedgerSummary {
  /** Runs with any captured contribution or reviewed-input diff. A run counts once even when both kinds are present. */
  runsWithDiff: number;
  /** Runs with neither contribution diff nor reviewed-input provenance; explicit empty/unavailable review input is counted in review-input buckets instead. */
  runsMissingDiff: number;
  /** Runs with available contribution diff stats, including oversized diffs with partial numstat totals. */
  runsWithContributionDiff: number;
  runsWithReviewInputDiff: number;
  runsWithEmptyReviewInputDiff: number;
  runsWithUnavailableReviewInputDiff: number;
  totalContributionFiles: number;
  totalContributionAdditions: number;
  totalContributionDeletions: number;
  reviewRounds: number;
  bugbotFindingsAddressed: number;
  humanReviewersRequestingChanges: number;
  humanCommentsAddressed: number;
  artifactFootprint: FamilyArtifactFootprint;
}

export interface FamilyChangeLedger {
  summary: FamilyChangeLedgerSummary;
  entries: FamilyChangeLedgerEntry[];
}

export type FlowType = 'fix-bug' | 'review-pr' | 'dev' | 'pr-complete' | 'update-branch';
export type RunLane = 'production' | 'validation' | 'comparison';

/**
 * Explicit branch-update strategy for the `update-branch` follow-up flow.
 * Kept off the flow name (the flow is "update this PR branch against its base";
 * how we do it is policy). Chained update-branch runs default to `rebase`;
 * `project-default` defers to the project's `merge_main_strategy` (ADR-042).
 * The worker resolves rebase-vs-merge against project force-push policy at
 * runtime and uses `--force-with-lease` for rebase pushes.
 */
export type BranchUpdateStrategy = 'rebase' | 'merge' | 'project-default';

export const BRANCH_UPDATE_STRATEGIES: readonly BranchUpdateStrategy[] = [
  'rebase',
  'merge',
  'project-default',
];

export function isBranchUpdateStrategy(value: unknown): value is BranchUpdateStrategy {
  return (
    typeof value === 'string' && (BRANCH_UPDATE_STRATEGIES as readonly string[]).includes(value)
  );
}

/**
 * Map legacy/persisted flow-type strings onto the current public {@link FlowType}
 * union. Applied at every load/migration boundary so pre-rename records (and any
 * legacy `feature` runs) never surface the old name in the UI:
 *   - `merge-main` → `update-branch` (branch-maintenance flow rename)
 *   - `feature`    → `dev`
 * Unknown values pass through unchanged so a genuinely new flow is not silently
 * rewritten.
 */
export function normalizeFlowType(value: string | null | undefined): FlowType {
  switch (value) {
    case 'merge-main':
      return 'update-branch';
    case 'feature':
      return 'dev';
    default:
      return (value ?? 'fix-bug') as FlowType;
  }
}

/**
 * Normalize a persisted CI-watch decision action id so pre-rename records
 * resolve to the current action without ever rendering the old label.
 * `dispatch-merge-main` → `dispatch-update-branch`; all other ids pass through.
 */
export function normalizeCiActionId(actionId: string): string {
  return actionId === 'dispatch-merge-main' ? 'dispatch-update-branch' : actionId;
}

export type DevInteractiveProfile = 'lightweight' | 'reviewed';

export const DEFAULT_DEV_INTERACTIVE_PROFILE: DevInteractiveProfile = 'lightweight';

export type DevInteractiveCompletionAction =
  | 'done-no-pr'
  | 'detect-pr-and-ci-watch'
  | 'link-pr-and-ci-watch'
  | 'link-pr-and-pr-complete'
  | 'run-self-review'
  | 'blocked'
  | 'failed'
  | 'abort';

export interface DevInteractiveActionRecord {
  action: DevInteractiveCompletionAction;
  source: 'operator';
  timestamp: string;
  reason?: string;
  prRef?: string;
}

/** Pipeline step names — single source of truth. Use these instead of string literals. */
export const PipelineSteps = {
  GRADE: 'grade',
  FIND_SLOT: 'find-slot',
  WRITE_TASK: 'write-task',
  PREPARE: 'prepare',
  DISPATCH: 'dispatch',
  MONITOR: 'monitor',
  SELF_REVIEW: 'self-review',
  COMPLETE: 'complete',
  HUMAN_GATE: 'human-gate',
  FINALIZE: 'finalize',
  CI_WATCH: 'ci-watch',
} as const;

export type PipelineStep = (typeof PipelineSteps)[keyof typeof PipelineSteps];

const S = PipelineSteps;

export const FLOW_STEPS: Record<FlowType, PipelineStep[]> = {
  'fix-bug': [
    S.FIND_SLOT,
    S.GRADE,
    S.WRITE_TASK,
    S.PREPARE,
    S.DISPATCH,
    S.MONITOR,
    S.SELF_REVIEW,
    S.COMPLETE,
    S.HUMAN_GATE,
    S.FINALIZE,
    S.CI_WATCH,
  ],
  'review-pr': [
    S.FIND_SLOT,
    S.WRITE_TASK,
    S.PREPARE,
    S.DISPATCH,
    S.MONITOR,
    S.HUMAN_GATE,
    S.COMPLETE,
  ],
  dev: [
    S.FIND_SLOT,
    S.WRITE_TASK,
    S.PREPARE,
    S.DISPATCH,
    S.MONITOR,
    S.SELF_REVIEW,
    S.COMPLETE,
    S.HUMAN_GATE,
    S.FINALIZE,
    S.CI_WATCH,
  ],
  'pr-complete': [
    S.FIND_SLOT,
    S.WRITE_TASK,
    S.PREPARE,
    S.DISPATCH,
    S.MONITOR,
    S.COMPLETE,
    S.FINALIZE,
    S.CI_WATCH,
  ],
  'update-branch': [
    S.WRITE_TASK,
    S.DISPATCH,
    S.MONITOR,
    S.SELF_REVIEW,
    S.COMPLETE,
    S.FINALIZE,
    S.CI_WATCH,
  ],
};

/**
 * Worker report artifact filename(s) per flow type, ordered by preference.
 * The retrospective decision reads the first non-empty match.
 *
 * - `fix-bug` / `dev` workers write `pr-description.md` (PR body + run summary)
 * - `pr-complete` worker writes `comments-report.md` (triage table, replies, fix commit)
 * - `review-pr` worker writes `review.md` (verdict + line comments)
 *
 * Adding a new flow = add an entry. Adding a new artifact = prepend to the list.
 * Falls back to `report.md` for any flow not listed.
 */
export const FLOW_WORKER_REPORT_ARTIFACTS: Record<FlowType, string[]> = {
  'fix-bug': ['pr-description.md', 'report.md'],
  'review-pr': ['review.md', 'report.md'],
  dev: ['pr-description.md', 'report.md'],
  'pr-complete': ['comments-report.md', 'report.md'],
  'update-branch': ['report.md'],
};

/** Default branch fallback. Projects should set `default_branch` in project.json. */
export const DEFAULT_BRANCH = 'main';

/** Default worker task directory (relative to repo root). Projects can override via `task_dir` in project.json. */
export const DEFAULT_TASK_DIR = '.task';

/** Default Claude model used when no slot/task/project/user override is set.
 * Changing this value alters defaults across the dispatch wizard and gateway
 * dispatch path — verify all `DEFAULT_CLAUDE_MODEL` callers when touching it. */
export const DEFAULT_CLAUDE_MODEL = 'opus';

/** Default Codex model used when no slot/task/project/user override is set.
 * GPT-5.6 family uses tiered slugs (sol/terra/luna); Sol is the flagship. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';

/** Default Codex reasoning effort when dispatch/launch omits effort. */
export const DEFAULT_CODEX_EFFORT = 'xhigh';

/** Default Cursor Agent model used when no slot/task/project/user override is set. */
export const DEFAULT_CURSOR_MODEL = 'cursor-grok-4.6-high-fast';

/** Default Grok model used when no slot/task/project/user override is set. */
export const DEFAULT_GROK_MODEL = 'grok-4.6';

/** Default Grok reasoning effort when dispatch/launch omits effort. */
export const DEFAULT_GROK_EFFORT = 'xhigh';
export type DecisionType =
  | 'collision_check'
  | 'plan_confirmation'
  | 'retrospective'
  | 'review_posting'
  | 'blocked_alert'
  | 'review_comments'
  | 'improvement'
  | 'recipe_strategy'
  | `engine_${string}`
  | `monitor_${string}`
  | `ci_${string}`;

/** Lightweight run summary for contextual display (e.g. decision cards). Derived from Run + RunMetrics. */
export interface RunMeta {
  runId: string;
  familyId?: string;
  flowType: FlowType;
  ticketOrPr: string;
  prNumber?: number;
  branch?: string;
  runner?: string;
  model?: string;
  summary?: string;
}

export interface PendingDecision {
  id: string;
  type: DecisionType;
  slotId: string | null;
  title: string;
  description: string;
  context: Record<string, unknown>;
  actions: DecisionAction[];
  createdAt: string;
  runMeta?: RunMeta;
  payload?: RunDecisionPayload;
}

export interface DecisionAction {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'danger';
  /** Optional one-line explanation of what this action does and when to pick it. Renders as
   *  hover tooltip + inline subtext under the button so operators don't have to guess. */
  description?: string;
}

// ─── Script Output ───

export interface ScriptOutput {
  requestId: string;
  stream: 'stdout' | 'stderr';
  data: string;
  timestamp: number;
}

export interface ScriptComplete {
  requestId: string;
  exitCode: number;
  duration: number;
  error?: string;
  artifactRoot?: string;
}
