import type { EvalExperimentProjection } from './evals.js';
import type { RecipeQualityArtifact, RecipeQualitySignal } from './recipes.js';
import type {
  DiffStat,
  FamilyChangeLedger,
  FamilyObservabilityArtifact,
  FlowType,
  HumanGrade,
  RunDecision,
  RunLane,
  RunLink,
  RunMetrics,
  RunStatus,
  RunStepStatus,
} from './runs.js';

export interface FamilyLearningEntry {
  id: string;
  runId: string;
  stepName?: string | null;
  source: 'worker-learnings' | 'self-review' | 'retrospective' | 'family-scope' | 'step-output';
  title: string;
  summary: string;
  detail?: string;
  createdAt: string;
  severity: 'info' | 'warn' | 'error';
}

export interface FamilyScopeAssessment {
  originalFamilyScopeSummary?: string;
  currentTriggerSummary?: string;
  scopeVerdict?: string;
  notes?: string;
}

export interface FamilyRecipeProvenance {
  source: 'historical-run';
  status: 'resolved' | 'ambiguous';
  sourceRunId?: string;
  sourceFamilyId?: string;
  sourceTaskFile?: string;
  sourceArtifactPath?: string;
  sourceSlotId?: string | null;
  reason: string;
  candidateRunIds?: string[];
}

export interface FamilyObservabilityStep {
  runId: string;
  stepName: string;
  status: RunStepStatus;
  detail?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  artifacts: FamilyObservabilityArtifact[];
  learnings: FamilyLearningEntry[];
  missingData: string[];
}

export interface FamilyObservabilityRunSummary {
  runId: string;
  familyId: string;
  parentRunId?: string | null;
  flowType: FlowType;
  lane: RunLane;
  variant?: string | null;
  status: RunStatus;
  project: string;
  ticketOrPr: string;
  branch: string | null;
  prNumber: number | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  slotId: string | null;
  workerReport: string | null;
  workerLearnings: string | null;
  recipeJson: string | null;
  recipeProvenance?: FamilyRecipeProvenance | null;
  recipeQualityArtifact: RecipeQualityArtifact | null;
  recipeQuality: RecipeQualitySignal;
  diffStat: DiffStat & { available: boolean };
  artifacts: FamilyObservabilityArtifact[];
  learnings: FamilyLearningEntry[];
  steps: FamilyObservabilityStep[];
  acceptanceCriteria: string[];
  ciChecks: Array<{ name: string; status: string; conclusion: string | null }>;
  selfReview: {
    verdict: string | null;
    summary: string | null;
    issues: Array<{ file: string; line?: number; description: string }>;
  };
  familyScope: FamilyScopeAssessment | null;
  humanGrade?: HumanGrade;
  proofTargets?: { id: string; target: string }[];
  decisions?: RunDecision[];
  metrics?: RunMetrics;
  /** External links resolved at engine time (e.g. Jira, PR). Mirrors {@link Run.links} so retro-style UIs can linkify ticket/PR refs without a second `run.get`. */
  links?: RunLink[];
  missingData: string[];
}

export interface RelatedRunSummary {
  runId: string;
  familyId: string;
  flowType: FlowType;
  status: RunStatus;
  project: string;
  ticketOrPr: string;
  branch: string | null;
  prNumber: number | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FamilyObservabilitySnapshot {
  familyId: string;
  familyRootTicketOrPr: string;
  project: string;
  generatedAt: string;
  latestRunId: string;
  latestPrNumber: number | null;
  workflowState: 'active' | 'complete' | 'failed';
  familyRunCount: number;
  activeRunCount: number;
  summary: string;
  diffStat: DiffStat & { available: boolean; runId?: string };
  familyChangeLedger?: FamilyChangeLedger;
  evidence: FamilyObservabilityArtifact[];
  recipeQuality: RecipeQualitySignal;
  learnings: FamilyLearningEntry[];
  runs: FamilyObservabilityRunSummary[];
  experiments?: EvalExperimentProjection[];
  /** Other runs that share the same ticket or GitHub PR number but live in a different family (prior attempts, separate lineages). */
  relatedByTicket: RelatedRunSummary[];
  missingData: string[];
}

export interface FamilyReportContent {
  summary: string;
  evidenceHighlights: string[];
  recipeAssessment: string;
  learnings: string[];
  unresolvedGaps: string[];
}

export interface FamilyReport {
  generatedAt: string;
  status: 'generated' | 'fallback';
  provider: string;
  model: string;
  error?: string;
  usage?: {
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    durationMs: number;
  };
  content: FamilyReportContent;
}

// Family contracts collect readiness, artifact, and change-ledger projections.
export type {
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
  RunFamilyCompletionState,
  RunFamilyReadinessSummary,
  RunListSummaryMeta,
  RunProjectAnalyticsSummary,
  RunSelfLearningBlockReason,
  RunSelfLearningEligibility,
  RunSelfLearningEligibilityState,
  RunSelfLearningMissingSignal,
} from './runs.js';
export {
  isFamilyDiffProvenance,
  RUN_SELF_LEARNING_BLOCK_REASONS,
  RUN_SELF_LEARNING_MISSING_SIGNALS,
} from './runs.js';
