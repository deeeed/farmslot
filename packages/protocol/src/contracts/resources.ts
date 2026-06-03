export type ResourceType = 'device' | 'browser' | 'dev-server' | 'service';

// `stale` = watch reports running but sidecar `meta.runId` mismatches the slot's currentRunId.
// Treated as a soft "orphan" signal — cleanup eligible but not yet broken.
export type ResourceStatus = 'unknown' | 'running' | 'stopped' | 'error' | 'stale';
export type ResourceStreamState = 'unknown' | 'starting' | 'ready' | 'error';

export type ResourceWatchType = 'pid-file' | 'port-listen' | 'process-poll';

export type SlotActionPlacement = 'slot-header' | 'resource-panel';
export type SlotActionStyle = 'primary' | 'secondary' | 'danger';
export type SlotActionRefreshTarget = 'resources' | 'fleet' | 'slot' | 'none';
export type SlotActionMode = 'run' | 'copy';

export interface SlotActionDefinition {
  label: string;
  command: string;
  description?: string;
  mode?: SlotActionMode;
  style?: SlotActionStyle;
  placement?: SlotActionPlacement[];
  confirm?: string;
  timeoutMs?: number;
  refresh?: SlotActionRefreshTarget[];
}

export interface SlotActionSummary {
  id: string;
  label: string;
  mode: SlotActionMode;
  style: SlotActionStyle;
  placement: SlotActionPlacement[];
  confirm?: string;
  description?: string;
  resourceId?: string;
  refresh: SlotActionRefreshTarget[];
}

export interface ResourceWatchConfig {
  type: ResourceWatchType;
  path?: string; // pid-file: PID file path (template vars expanded by gateway)
  port?: string; // port-listen: port number or template var (e.g. "{{port}}")
  cmd?: string; // process-poll: shell command (template vars expanded by gateway)
  intervalMs?: number; // zombie check / poll interval (default: 10000)
}

export interface ResourceDefinition {
  type: ResourceType;
  platform?: string; // links to platforms[key] for existing hooks
  label: string;
  streamable: boolean;
  controllable: boolean;
  watch?: ResourceWatchConfig;
  hooks?: {
    boot?: string;
    shutdown?: string;
    relaunch?: string;
    health?: string;
  };
  actions?: Record<string, SlotActionDefinition>;
}

export interface ResourceStreamStatus {
  state: ResourceStreamState;
  detail?: string;
  updatedAt?: string;
}

export interface ResourceStateUpdate {
  id: string;
  status: ResourceStatus;
  stream?: ResourceStreamStatus;
}

export interface SlotResource {
  id: string; // "ios-sim", "android-emu", "browser"
  definition: ResourceDefinition;
  status: ResourceStatus;
  stream?: ResourceStreamStatus;
}

// Sticky pointer maintained by the gateway for the live PID backing a
// (slot, resource) pair. Replaces ad-hoc `browserPid` captures so stream
// consumers rebind across relaunches instead of pinning a dead pid.
// Sidecar metadata read from `<pidPath>.meta`. Identifies the run that spawned
// the process so gateway can flag stale ownership as `stale` (see ResourceRollup).
export interface ResourceSidecarMeta {
  runId: string;
  slotId: string;
  startedAt: string;
}

export interface ActiveResourcePointer {
  pid: number;
  startedAt: string;
  runId: string | null;
  cdpPort?: number;
  meta?: ResourceSidecarMeta;
}

// Composite coherence verdict for a slot's watched resources.
// `coherent` only when every resource is running AND (if sidecars present)
// the sidecar `meta.runId` matches the slot's current run.
export type ResourceRollup = 'coherent' | 'partial' | 'stale' | 'none';

// ─── Stream Feed ───

export interface StreamFrame {
  slotId: string;
  timestamp: number;
  width: number;
  height: number;
  keyFrame: boolean;
  seq: number;
}

export interface StreamStatus {
  slotId: string;
  active: boolean;
  width: number;
  height: number;
  fps: number;
  platform: string;
  deviceName: string;
}

/** Shared browser-context shape used by gateway→node RPCs (screen.subscribe, screen.thumbnail).
 *  Gateway may set browserPid=null to signal "tried but failed to resolve"; node treats null/undefined
 *  identically and falls back to local pid-file walk + lsof. */
export interface BrowserContextParams {
  browserPid?: number | null;
  cdpPort?: number;
  repo?: string;
  runtimeDir?: string;
}

// ─── Runs ───

export type {
  BranchAffinityNudgePayload,
  CollisionPayload,
  CommentsTriageSummary,
  DiffStat,
  EvidenceManifestEntry,
  EvidenceManifestStandalone,
  FamilyArtifactBucketSummary,
  FamilyArtifactFootprint,
  FamilyChangeLedger,
  FamilyChangeLedgerEntry,
  FamilyChangeLedgerSummary,
  FamilyDiffKind,
  FamilyDiffProvenance,
  FamilyDiffProvenanceSource,
  FamilyInputCommitMetadata,
  FamilyObservabilityArtifact,
  FamilyReviewSignalSummary,
  GatePolicy,
  HumanGrade,
  ImprovementDiffPayload,
  ImprovementFileChange,
  IndependentReviewAttempt,
  IndependentReviewStatus,
  IntelligenceAction,
  IntelligenceActionActor,
  IntelligenceActionFollowup,
  IntelligenceActionGuard,
  IntelligenceActionOutcome,
  IntelligenceActionOutcomeReason,
  IntelligenceActionProposedType,
  IntelligenceActionsSummary,
  IntelligenceActionTier,
  LinkedTicket,
  LiveRecipeContext,
  LiveRecipeSelectionReason,
  LiveRecipeSource,
  NoChangeGatePayload,
  ProofTargetVerdict,
  PublicationStatus,
  PublicationTarget,
  ReadyGateInputSnapshot,
  ReadyGatePayload,
  ReadyGatePrPackage,
  RecipeRunArtifactGroup,
  RecipeRunArtifactGroupKind,
  RecipeRunArtifactGroupStatus,
  RetrospectivePayload,
  ReviewDepthPolicy,
  ReviewDiffSnapshot,
  ReviewFixDeltaSnapshot,
  ReviewGatePayload,
  ReviewLineComment,
  ReviewLoopRequest,
  ReviewLoopTimelineSegment,
  ReviewLoopTimelineSegmentKind,
  ReviewRunnerId,
  ReviewValidationDepth,
  Run,
  RunAutoRecoveryProposalStatus,
  RunCiWatchState,
  RunCompletionPolicy,
  RunDecision,
  RunDecisionPayload,
  RunEngineState,
  RunFamilyCompletionState,
  RunFamilyReadinessSummary,
  RunGrade,
  RunLink,
  RunListSummaryMeta,
  RunMetrics,
  RunMonitorState,
  RunnerSessionUsage,
  RunProjectAnalyticsSummary,
  RunRecoveryRuntimeProposal,
  RunReplayStep,
  RunSelfLearningBlockReason,
  RunSelfLearningEligibility,
  RunSelfLearningEligibilityState,
  RunSelfLearningMissingSignal,
  RunStartRefProvenance,
  RunStartRefSource,
  RunStatus,
  RunStep,
  RunStepStatus,
  RunTicketData,
  SlotPickerPayload,
  SlotRunHistoryEntry,
  WorkerTerminalDisposition,
  WorkerTerminalEvidence,
} from './runs.js';
export {
  buildComparisonVariant,
  DEFAULT_GRADER_ID,
  hasLiveRecipeEvidence,
  INTELLIGENCE_ACTION_ACTORS,
  INTELLIGENCE_ACTION_FOLLOWUPS,
  INTELLIGENCE_ACTION_OUTCOME_REASONS,
  INTELLIGENCE_ACTION_OUTCOMES,
  INTELLIGENCE_ACTION_PROPOSED_TYPES,
  INTELLIGENCE_ACTION_TIERS,
  isFamilyDiffProvenance,
  isInteractiveDevRun,
  isLightweightInteractiveDevRun,
  isReviewValidationDepth,
  isTerminalRunStatus,
  LIVE_RECIPE_EVIDENCE_FILES,
  LIVE_RECIPE_EVIDENCE_PURPOSES,
  modelsMatch,
  nextFreeComparisonVariant,
  REVIEW_VALIDATION_DEPTHS,
  reviewValidationDepthForLoop,
  RUN_SELF_LEARNING_BLOCK_REASONS,
  RUN_SELF_LEARNING_MISSING_SIGNALS,
  TERMINAL_RUN_STATUSES,
} from './runs.js';
