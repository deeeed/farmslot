// step-io.ts — Typed step I/O and shared recipe artifact interfaces
// Phase 1 of the Step I/O Refactor (prerequisite for C3 fine-tuning export).
// RunStep.inputs/outputs remains Record<string, unknown> for backward compat.
// These interfaces are used by step executors and consumers via typed casts.

// ─── Shared Foundation Types ───

export interface SubStepRecord {
  name: string;
  outcome: 'ok' | 'skipped' | 'failed';
  durationMs: number;
  detail?: string;
}

// ─── Recipe Artifact Manifest ───

export const RECIPE_ARTIFACT_TYPES = [
  'screenshot',
  'video',
  'log',
  'trace',
  'summary',
  'json',
  'report',
  'metric',
  'diff',
  'recipe',
  'other',
] as const;

export type RecipeArtifactType = (typeof RECIPE_ARTIFACT_TYPES)[number];
// Keeps the known vocabulary autocomplete-friendly while allowing project-specific extensions.
export type RecipeArtifactTypeName = RecipeArtifactType | (string & {});

export interface RecipeArtifactRecorderTarget {
  selector: string;
  value: string;
}

export interface RecipeArtifactRecorderMetadata {
  name?: string;
  version?: string;
  platform?: string;
  target?: RecipeArtifactRecorderTarget;
}

export interface RecipeArtifactManifestEntry {
  path: string;
  type: RecipeArtifactTypeName;
  label?: string;
  nodeId?: string;
  mimeType?: string;
  category?: 'proof' | 'debug' | 'diagnostic' | 'system' | (string & {});
  proofTarget?: string;
  covers?: string[];
  record?: 'full_run' | 'proof_window' | (string & {});
  recorder?: RecipeArtifactRecorderMetadata;
  maxFps?: number;
}

export interface RecipeRunnerProvenance {
  source: string;
  git_ref: string;
  name?: string;
  version?: string;
}

export interface RecipeArtifactManifestDocument {
  version: 1;
  // Reserved for consumers that need a manifest-level status badge before summary.json is loaded.
  runStatus?: 'pass' | 'fail' | 'unknown';
  provenance?: {
    runner?: RecipeRunnerProvenance;
  };
  artifacts: RecipeArtifactManifestEntry[];
}

export interface ArtifactRef {
  path: string; // relative to task dir
  purpose: string; // "task-md", "report", "review", "recipe", "video-before", etc.
  sha256?: string;
  sizeBytes?: number;
  type?: RecipeArtifactTypeName;
  label?: string;
  nodeId?: string;
  mimeType?: string;
  maxFps?: number;
}

const PUBLISH_EVIDENCE_MEDIA_EXTS = /\.(png|jpg|jpeg|gif|mp4|mov|webm)$/i;

export function isPublishEvidenceArtifact(
  artifact: Pick<ArtifactRef, 'path' | 'purpose'>,
): boolean {
  const normalizedPath = artifact.path.replace(/\\/g, '/').toLowerCase();
  return (
    PUBLISH_EVIDENCE_MEDIA_EXTS.test(artifact.path) &&
    artifact.purpose?.toLowerCase() !== 'debug-screenshot' &&
    !/(^|\/)screenshots\//.test(normalizedPath)
  );
}

export interface MonitorSnapshot {
  timestamp: string;
  trigger: 'violation' | 'phase-transition' | 'decision' | 'nudge';
  violation?: { type: string; message: string };
  taskProgress?: { completedSteps: number; totalSteps: number; currentPhase: string };
}

/** Per-step LLM usage — every HEU step output includes this.
 *  Enables per-step cost tracking and model comparison across runs.
 *  Populated by callLLM() wrapper when it exists; manual until then. */
export interface StepLLMUsage {
  provider: string; // "anthropic", "openai", "cli" (for claude -p)
  model: string; // "haiku", "opus", "sonnet", "gpt-4o"
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs: number;
}

// ─── grade ───

export interface GradeStepInput {
  ticketOrPr: string;
  ticketSource?: string; // "jira", "github", "both", "manual"
}

export interface GradeStepOutput {
  difficulty?: string;
  score?: number;
  modelRecommendation?: string;
  rationale?: string;
  source?: string;
  title?: string;
  flowTypeMismatch?: string | null;
  llm?: StepLLMUsage;
  summary?: string;
  branchSlug?: string;
  summaryLlm?: StepLLMUsage;
}

// ─── find-slot ───

export interface FindSlotStepInput {
  project: string;
  flowType: string;
  requestedSlotId?: string;
}

export interface SlotCandidate {
  slotId: string;
  score: number;
  cdpLive: boolean;
}

export interface FindSlotStepOutput {
  selectedSlot: string;
  runner: string;
  model: string;
  selectionMethod: 'user-specified' | 'affinity' | 'scored';
  candidateCount: number;
  candidates: SlotCandidate[];
}

// ─── write-task ───

export interface WriteTaskStepInput {
  flowType: string;
  hasTicketData: boolean;
}

export interface WriteTaskStepOutput {
  taskFile: string;
  skipped?: boolean;
  collision?: boolean;
  templateName?: string;
  taskRelDir?: string;
  branch?: string;
  artifacts?: ArtifactRef[];
  variableCount?: number;
  llm?: StepLLMUsage;
  summary?: string;
  branchSlug?: string;
  recipeStrategy?: import('../contracts/index.js').RecipeStrategyDecision;
  subSteps?: SubStepRecord[];
}

// ─── prepare ───

export interface PrepareStepInput {
  slotId: string;
  branch?: string;
  mergeMain: boolean;
  flowType: string;
}

export interface PrepareStepOutput {
  success: boolean;
  subSteps: SubStepRecord[];
  machine?: string;
  platform?: string;
  isLocal?: boolean;
  healthValue?: string;
  cliCommand?: string;
}

// ─── dispatch ───

export interface DispatchStepInput {
  slotId: string;
  runner?: string;
  model?: string;
  taskFile: string;
}

export interface DispatchStepOutput {
  success: boolean;
  subSteps: SubStepRecord[];
  launchCommand?: string;
  readinessWaitMs?: number;
  promptSent?: boolean;
  cliCommand?: string;
}

// ─── monitor ───

export interface MonitorStepInput {
  slotId: string;
  pollIntervalMs?: number;
  stuckTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxNudges?: number;
}

export interface MonitorStepOutput {
  nudgeCount: number;
  pollCount: number;
  exitReason: 'worker-done' | 'cancelled' | 'timeout' | 'aborted' | 'error';
  violations: Array<{ type: string; message: string; timestamp: string }>;
  snapshots: MonitorSnapshot[];
  finalTaskProgress?: { completedSteps: number; totalSteps: number };
  cliCommand?: string;
}

// ─── self-review ───

export interface SelfReviewStepInput {
  slotId: string;
  enabled: boolean;
  model?: string;
}

export interface SelfReviewIssue {
  file: string;
  line?: number;
  description: string;
}

export interface SelfReviewStepOutput {
  skipped?: boolean;
  reason?: string;
  verdict?: 'pass' | 'issues';
  issues?: SelfReviewIssue[];
  retryCount?: number;
  feedbackSent?: boolean;
  durationMs?: number;
  cliCommand?: string;
}

// ─── human-gate ───

export interface HumanGateStepInput {
  gateType: string;
  gateEnabled: boolean;
}

export interface HumanGateStepOutput {
  skipped?: boolean;
  reason?: string;
  waitDurationMs?: number;
  resolvedAction?: string | null;
  gatePayloadSummary?: string;
  artifacts?: ArtifactRef[];
}

// ─── complete ───

export interface CompleteStepInput {
  slotId: string;
  flowType: string;
}

export interface CompleteStepOutput {
  prNumber: number | null;
  ciRepo: string | null;
  artifactsCopied: boolean;
  prCommentPosted: boolean;
  prTitleUpdated: boolean;
  prMarkedReady: boolean;
  retrospectiveCreated: boolean;
  slotDisposition: 'ci-watch' | 'released';
  artifacts: ArtifactRef[];
  cliCommand?: string;
}

// ─── finalize ───

export interface FinalizeStepInput {
  slotId: string;
  flowType: string;
}

export interface SessionMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  model: string;
  sessionDurationMs: number;
  numCompactions?: number;
  numTurns?: number;
}

export interface FinalizeStepOutput {
  session?: SessionMetrics;
  commentPosted: boolean;
  metricsSavedToTask: boolean;
  artifactPath?: string;
  cliCommand?: string;
}

// ─── ci-watch ───

export interface CIWatchStepInput {
  prNumber?: number;
}

export type CIWatchPhase =
  | 'polling'
  | 'deduped'
  | 'fixing'
  | 'waiting_for_worker'
  | 'blocked'
  | 'decision_required'
  | 'done';

export type CIWatchFixTrigger = 'failed_checks' | 'bot_comments' | null;

export interface CIWatchFixProgress {
  completed: number;
  total: number;
  currentLabel?: string | null;
}

export interface CIWatchStepOutput {
  skipped?: boolean;
  reason?: string;
  result?: string;
  failedChecks?: string[];
  phase?: CIWatchPhase;
  fixInProgress?: boolean;
  fixTrigger?: CIWatchFixTrigger;
  activeTaskFile?: string | null;
  nextPollAt?: string | null;
  lastSignalAt?: string | null;
  dedupReason?: string | null;
  lastFixCommitSha?: string | null;
  fixProgress?: CIWatchFixProgress;
  timeoutWindowStartedAt?: string;
  lastProgressAt?: string;
  lastProgressReason?: string;
  pollCount: number;
  pollIntervalMs?: number;
  lastCheckedAt?: string;
  totalDurationMs: number;
  checkTimeline: Array<{ timestamp: string; status: string; detail?: string }>;
  actionableBotCommentCount: number;
  cliCommand?: string;
}
