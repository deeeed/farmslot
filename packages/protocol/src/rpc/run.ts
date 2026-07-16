import type {
  FlowType,
  IntelligenceActionsSummary,
  OkResult,
  RecipeRunArtifactGroup,
  Run,
  RunFamilyReadinessSummary,
  RunListSummaryMeta,
  RunProjectAnalyticsSummary,
  RunStatus,
  SlotRunHistoryEntry,
} from '../contracts/index.js';

import { Methods } from './registry.js';

export const RunMethods = {
  create: Methods.RUN_CREATE,
  get: Methods.RUN_GET,
  list: Methods.RUN_LIST,
  slotHistory: Methods.RUN_SLOT_HISTORY,
  contextBundle: Methods.RUN_CONTEXT_BUNDLE,
  recoveryProposal: Methods.RUN_RECOVERY_PROPOSAL,
  cancel: Methods.RUN_CANCEL,
  forceComplete: Methods.RUN_FORCE_COMPLETE,
  pause: Methods.RUN_PAUSE,
  resume: Methods.RUN_RESUME,
  replayStep: Methods.RUN_REPLAY_STEP,
  activateOnSlot: Methods.RUN_ACTIVATE_ON_SLOT,
  autoRecoveryStop: Methods.RUN_AUTO_RECOVERY_STOP,
  ciWatchPoke: Methods.RUN_CI_WATCH_POKE,
  refreshReviewGate: Methods.RUN_REFRESH_REVIEW_GATE,
  refreshPublishPackage: Methods.RUN_REFRESH_PUBLISH_PACKAGE,
  refreshMirror: Methods.RUN_REFRESH_MIRROR,
  rehydratePrNumber: Methods.RUN_REHYDRATE_PR_NUMBER,
  interactiveDevResolve: Methods.RUN_INTERACTIVE_DEV_RESOLVE,
  forSlot: Methods.RUN_FOR_SLOT,
  resolveDecision: Methods.RUN_RESOLVE_DECISION,
  probeWorkerSignal: Methods.RUN_PROBE_WORKER_SIGNAL,
  grade: Methods.RUN_GRADE,
  getGrade: Methods.RUN_GET_GRADE,
  proposeImprovement: Methods.RUN_PROPOSE_IMPROVEMENT,
  delete: Methods.RUN_DELETE,
  archive: Methods.RUN_ARCHIVE,
  bulkDelete: Methods.RUN_BULK_DELETE,
  cleanup: Methods.RUN_CLEANUP,
  setTags: Methods.RUN_TAGS_SET,
  listTags: Methods.RUN_TAGS_LIST,
  backfillSummaries: Methods.RUN_BACKFILL_SUMMARIES,
  recipeRunsForSlot: Methods.RUN_RECIPE_RUNS_FOR_SLOT,
  recipeRunsForRun: Methods.RUN_RECIPE_RUNS_FOR_RUN,
} as const;

// Run RPC also exposes adjacent run-facing params owned by chat/decisions so
// callers can import one run RPC contract module.
export type {
  RunContextBundleParams,
  RunContextBundleResult,
  RunRecoveryProposalParams,
  RunRecoveryProposalResult,
} from './chat.js';
export type { DecisionListResult, DecisionResolveParams } from './decisions.js';

// ─── Run param/result types ───

export interface RunCreateParams {
  flowType: FlowType;
  project: string;
  ticketOrPr: string;
  familyId?: string;
  parentRunId?: string;
  familyRootTicketOrPr?: string;
  lane?: import('../contracts/index.js').RunLane;
  variant?: string | null;
  /** Selected project-owned worker template version for this run. */
  taskTemplate?: import('../contracts/index.js').TaskTemplateSelection;
  slotId?: string;
  taskFile?: string;
  branch?: string;
  /** Pre-fetched/manual ticket payload used by the worker task renderer. */
  ticketData?: import('../contracts/index.js').RunTicketData;
  /** Initial engine linkage/state that must exist before the run engine starts. */
  engineState?: import('../contracts/index.js').RunEngineState;
  completionPolicy?: import('../contracts/index.js').RunCompletionPolicy;
  /**
   * Artifact-only comparison replay base. V1 accepts this only for
   * flowType='dev' or 'fix-bug' + lane='comparison' + explicit variant +
   * completionPolicy='artifact-only'.
   */
  startRef?: string;
  startRefSource?: import('../contracts/index.js').RunStartRefSource;
  /**
   * Known PR number at dispatch time. PR-bound flows derive this from
   * owner/repo#number input so run-family and review surfaces can link the
   * PR before completion/CI-watch learns any produced PR.
   */
  prNumber?: number;
  model?: string;
  runner?: string;
  /** Worker scripted-runner config when runner='scripted'. */
  scripted?: import('../contracts/index.js').ScriptedRunnerConfig;
  effort?: string;
  app?: string;
  /**
   * Named domain overlay for this run. Free-form and project-defined — the
   * framework only threads it through prepare/fixture sync as the `DOMAIN`
   * compose variable and the `{{domain}}` template placeholder. Unset = no
   * domain overlay (existing single-domain behavior).
   */
  domain?: string;
  mode?: 'interactive' | 'autonomous' | 'validation';
  /** Skip slot prepare entirely — operator owns slot state (ADR-037 §5). */
  skipPrepare?: boolean;
  /**
   * Gateway-internal: set by run.create after verifying slot HEAD matches startRef.
   * External callers must not set this — use skipPrepare + slotId and let run.create verify.
   */
  startRefSkipPrepareVerified?: boolean;
  /** Named prepare profile from the project's prepare.profiles (ADR-037). */
  prepareProfile?: string;
  /**
   * Branch-update strategy for `update-branch` runs (rebase | merge |
   * project-default). Ignored for other flows. Persisted on the run and
   * rendered into the worker task as the `BRANCH_UPDATE_STRATEGY` template var
   * (not the prepare-time ADR-042 `merge_main_strategy`).
   */
  branchUpdateStrategy?: import('../contracts/index.js').BranchUpdateStrategy;
  /** Branch-affinity nudge — operator picked "Nudge worker" in the dispatch wizard for a
   * busy slot already on this PR's branch. Engine binds `slotId`, skips PREPARE, and routes
   * DISPATCH through `nudgeDispatch` (send-keys into the existing tmux session) instead of
   * relaunching. Requires `slotId` to be set in the same request. */
  nudgeReuse?: boolean;
  /** Branch-affinity fresh-reuse — operator picked "Kill & dispatch fresh" for a busy slot
   * already on this PR's branch. Engine binds `slotId`, hard-kills the prior worker BEFORE
   * PREPARE so git reset / checkout / dependency install don't race the worker writing in
   * the same worktree, then proceeds with normal PREPARE + DISPATCH. Requires `slotId` to
   * be set in the same request. Mutually exclusive with `nudgeReuse`. */
  freshReuse?: boolean;
  /** Force a review tier for review-pr flow. '' or omitted = auto (LLM picks strategy).
   * light → smoke; standard → smoke|targeted; full → targeted|full-qa. */
  reviewTier?: string;
  /** Fix-bug local-first publication gate review depth requested at dispatch time. */
  reviewDepth?: import('../contracts/index.js').ReviewDepthPolicy;
  /** Ordered extra review loops to run before the first ready gate is shown. */
  pendingReviewPlan?: import('../contracts/index.js').ReviewLoopRequest[];
  /** Runner execution safety tier (ADR-023). Overrides runner/project defaults. */
  safetyTier?: import('../contracts/index.js').SafetyTier;
  /**
   * Restrict FIND_SLOT (and any affinity reuse) to this set of slot IDs. The UI
   * resolves its filters against the live fleet before dispatch so the server
   * has no filter semantics to grow as new UI filter dimensions appear. Empty /
   * omitted means the whole project-wide pool is eligible.
   */
  allowedSlots?: string[];
  /** Internal backlog handoff link. Public run.create rejects this; backlog.enqueue owns it. */
  backlogItemId?: string;
  /** Internal work-graph handoff link. Public run.create rejects this; workGraph.schedulerTick owns it. */
  workGraphId?: string;
  workNodeId?: string;
  /** Internal backlog launch-plan linkage. Public run.create rejects this; backlog.enqueue owns it. */
  launchPlanId?: string;
  launchCandidateId?: string;
  launchGroupId?: string;
  launchSlotPolicy?: import('../contracts/index.js').BacklogLaunchSlotPolicy['kind'];
  /** Monotonic per-candidate launch attempt (MANUAL-000037); backlog.enqueue owns it. */
  launchAttempt?: number;
  /** Dev-only interactive policy. Defaults to lightweight for interactive dev runs. */
  devInteractiveProfile?: import('../contracts/index.js').DevInteractiveProfile;
  /** Shared normalized tags for planning/execution filtering. */
  tags?: string[];
  /** Operator's initial context before the gateway normalizes it into a local DEV-* identity. */
  initialContext?: string;
  /** Optional operator-owned checklist rendered beside TASK.md for lightweight dev. */
  devChecklist?: string[];
}

export interface RunCreateResult {
  run: Run;
}

export interface RunGetParams {
  runId: string;
}

export interface RunGetResult {
  run: Run;
}

export interface RunListParams {
  status?: RunStatus;
  active?: boolean;
  limit?: number;
  flowType?: FlowType;
  project?: string;
  prNumber?: number;
  familyId?: string;
  lane?: import('../contracts/index.js').RunLane;
  variant?: string | null;
  outcome?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  tags?: string[];
  sort?: 'newest' | 'oldest' | 'duration' | 'grade';
  /** Include page-scoped, metadata-only family readiness summaries for the returned runs. */
  includeFamilySummaries?: boolean;
  /** Include page-scoped, metadata-only per-project analytics summaries for the returned runs. */
  includeProjectAnalytics?: boolean;
}

export interface RunListResult {
  runs: Run[];
  totalCount: number;
  /** Summary metadata is present only when a summary flag was requested. */
  summaryMeta?: RunListSummaryMeta;
  /** Page-scoped family summaries for the returned runs; absent unless includeFamilySummaries is true. */
  familySummaries?: RunFamilyReadinessSummary[];
  /** Page-scoped project analytics for the returned runs; absent unless includeProjectAnalytics is true. */
  projectAnalytics?: RunProjectAnalyticsSummary[];
}

export interface SlotRunHistoryParams {
  slotId: string;
  /** Defaults to 25; must be a positive finite integer. Gateway caps excessive values to keep modal opens cheap. */
  limit?: number;
}

export interface SlotRunHistoryResult {
  slotId: string;
  /** False when the requested slot is absent from the current fleet snapshot; retained history can still be returned. */
  slotExists: boolean;
  runs: SlotRunHistoryEntry[];
  totalCount: number;
}

export interface RunCancelParams {
  runId: string;
  reason?: string;
}

export interface RunCancelResult {
  run: Run;
}

export interface RunForceCompleteParams {
  runId: string;
}

export interface RunForceCompleteResult {
  run: Run;
}

export interface RunPauseParams {
  runId: string;
}

export interface RunPauseResult {
  run: Run;
}

export interface RunResumeParams {
  runId: string;
}

export interface RunResumeResult {
  run: Run;
}

export interface RunReplayStepParams {
  runId: string;
  stepName: string;
  /** Skip slot prepare on replay entirely — operator owns slot state (ADR-037 §5). */
  skipPrepare?: boolean;
  /** Replay PREPARE with this named profile; persisted on the run before the engine restarts. */
  prepareProfile?: string;
  triggeredBy?: 'operator' | 'auto-recovery';
  intelligenceActionId?: string;
}

export interface RunAutoRecoveryStopParams {
  runId: string;
}
export interface RunAutoRecoveryStopResult {
  run: Run;
}

export interface SlotFixtureRefreshParams {
  slotId: string;
  requestId?: string;
  flowType?: FlowType;
  app?: string;
  /** Named domain overlay — forwarded to fixture sync as the `DOMAIN` compose variable. */
  domain?: string;
}
export interface SlotFixtureRefreshResult {
  ok: true;
  requestId: string;
  logPath: string;
}

export interface IntelligenceActionsSummaryParams {
  limit?: number;
  /** Inclusive lower bound on action decidedAt ISO timestamp. */
  dateFrom?: string;
  /** Inclusive upper bound on action decidedAt ISO timestamp. */
  dateTo?: string;
}
export interface IntelligenceActionsSummaryResult {
  summary: IntelligenceActionsSummary;
}

export interface RunReplayStepResult {
  run: Run;
}

/**
 * Re-bind an existing run onto a slot and re-drive PREPARE→DISPATCH with the
 * cheapest warm prepare profile, instead of creating a fresh run (ADR-024
 * Activate-on-Slot addendum). Used to switch between hot runs across slots.
 *
 * RPC/CLI-only: no UI button calls this (re-driving a gate-held run is a
 * footgun — it relaunches the worker and destroys gate state). The UI's
 * "Load slot with run" affordance uses the bind-only `slot.prepare` path, which
 * does NOT re-drive the pipeline. Reach for this only to re-run a terminal run,
 * move a run to another slot, or recover a dead worker.
 */
export interface RunActivateOnSlotParams {
  runId: string;
  /** Target slot. Defaults to the run's current `slotId` when omitted. */
  slotId?: string;
  /** Prepare profile for the re-bind; defaults to `attach` (cheapest warm reuse). */
  prepareProfile?: string;
}

export interface RunActivateOnSlotResult {
  run: Run;
}

export interface RunCIWatchPokeParams {
  runId: string;
}

export type RunCIWatchPokeResult = { ok: true; woken: boolean } | { ok: false; reason: string };

export interface RunRefreshReviewGateParams {
  runId: string;
}

export interface RunRefreshReviewGateResult {
  run: Run;
}

export interface RunRefreshPublishPackageParams {
  runId: string;
  decisionId?: string;
  selectedEvidenceKeys?: string[];
  publicationTarget?: import('../contracts/index.js').PublicationTarget;
}

export interface RunRefreshPublishPackageResult {
  run: Run;
  packageId: string;
  packageHash: string;
  packageHeadSha?: string;
  packageInputHash?: string;
  reviewSubjectHash?: string;
  preservedEvidenceKeys: string[];
  droppedEvidence: { key: string; reason: string }[];
  droppedEvidenceKeys: string[];
  addedEvidenceKeys: string[];
}

export interface RunRefreshMirrorParams {
  runId: string;
}

export type RunRefreshMirrorResult = { ok: true; copied: number } | { ok: false; reason: string };

export interface RunRehydratePrNumberParams {
  runId: string;
  /** Operator-supplied PR ref for interactive/manual dev runs where auto-detect is not enough. */
  prRef?: string;
}

export type RunRehydratePrNumberResult =
  | { ok: true; prNumber: number; run: Run; reason?: string }
  | { ok: false; reason: string };

export interface RunInteractiveDevResolveParams {
  runId: string;
  action: import('../contracts/index.js').DevInteractiveCompletionAction;
  prRef?: string;
  reason?: string;
}

export type RunInteractiveDevResolveResult =
  | { ok: true; run: Run; prNumber?: number; chainedRunId?: string; reason?: string }
  | { ok: false; run?: Run; reason: string; needsPr?: boolean };

export interface RunForSlotParams {
  slotId: string;
}

export interface RunForSlotResult {
  run: Run | null;
}

export interface RunRecipeRunsForSlotParams {
  slotId: string;
}

export interface RunRecipeRunsForSlotResult {
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRunId: string | null;
}

export interface RunRecipeRunsForRunParams {
  runId: string;
}

export interface RunRecipeRunsForRunResult {
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRunId: string | null;
}

export interface RunResolveDecisionParams {
  runId: string;
  decisionId: string;
  actionId: string;
  selectionData?: Record<string, unknown>;
}

export interface RunResolveDecisionResult {
  run: Run;
}

export interface RunProbeWorkerSignalParams {
  runId: string;
}

export type RunProbeWorkerSignalResult = import('../transport/signal.js').WorkerSignalProbeResult;

export interface RunGradeParams {
  runId: string;
  grade: import('../contracts/index.js').HumanGrade;
}

export interface RunGradeResult {
  run: import('../contracts/index.js').Run;
}

export interface RunGetGradeParams {
  runId: string;
}

export interface RunGetGradeResult {
  grade: import('../contracts/index.js').HumanGrade | null;
}

// ─── Run cleanup param/result types ───

export interface RunDeleteParams {
  runId: string;
}

export interface RunDeleteResult {
  ok: boolean;
}

export interface RunTagsSetParams {
  runId: string;
  tags: string[];
}

export interface RunTagsSetResult {
  run: Run;
}

export interface RunTagsListResult {
  tags: Array<{ tag: string; count: number }>;
}

export interface RunArchiveParams {
  runId: string;
}

export interface RunArchiveResult {
  ok: boolean;
}

export interface RunBulkDeleteParams {
  runIds: string[];
}

export interface RunBulkDeleteResult {
  deleted: number;
}

export interface RunCleanupParams {
  dryRun?: boolean;
}

export interface RunCleanupResult {
  taskDirsRemoved: string[];
  runsArchived: string[];
  syntheticRunsDeleted: string[];
}

export interface RunProposeImprovementParams {
  runId: string;
  rationale?: string;
}

/**
 * Fire-and-forget: the real improvement decision arrives later via a
 * `run.decision.new` event once the LLM analysis completes. UI should show
 * an "analyzing" state until a decision with `type === 'improvement'` lands.
 */
export type RunProposeImprovementResult = OkResult;

export interface FamilyObservabilityGetParams {
  familyId: string;
  project?: string;
}

export interface FamilyObservabilityGetResult {
  snapshot: import('../contracts/index.js').FamilyObservabilitySnapshot;
}

export interface FamilyReportGenerateParams {
  familyId: string;
  project?: string;
  forceRefresh?: boolean;
}

export interface FamilyReportGenerateResult {
  snapshot: import('../contracts/index.js').FamilyObservabilitySnapshot;
  report: import('../contracts/index.js').FamilyReport;
}

export interface RunBundleExportParams {
  runId?: string;
  runIds?: string[];
  familyId?: string;
  profile?: import('../contracts/run-bundles.js').RunBundleProfile;
  outputPath: string;
}

export interface RunBundleImportParams {
  bundlePath: string;
  mode?: import('../contracts/run-bundles.js').RunBundleImportMode;
  force?: boolean;
}

export interface RunBundleListParams {
  bundlePath: string;
}
