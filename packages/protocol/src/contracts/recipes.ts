import type { FlowType } from './runs.js';

export type EvidenceQualityVerdict = 'RELEVANT_HIGH' | 'RELEVANT_LOW' | 'IRRELEVANT' | 'MISSING';

/** Evidence strategy the worker uses for a review-pr run.
 * - `smoke`: backend smoke regression only (no UI evidence).
 * - `targeted`: smoke + screenshots for changed UI surfaces.
 * - `full-qa`: screenshots plus opt-in video when motion proof is useful. */
export type RecipeStrategyToken = 'full-qa' | 'smoke' | 'targeted';

export interface RecipeStrategyDecision {
  strategy: RecipeStrategyToken;
  reasoning: string;
  diffSummary: string;
  uiImpact: boolean;
  mode: 'suggest' | 'autonomous';
}

export const RECIPE_STRATEGY_LABELS: Record<
  RecipeStrategyToken,
  { label: string; tagline: string }
> = {
  'full-qa': { label: 'Full QA', tagline: 'screenshots + opt-in motion video' },
  targeted: { label: 'Targeted evidence', tagline: 'smoke + screenshots for changed UI' },
  smoke: { label: 'Smoke only', tagline: 'backend regression test, no UI evidence' },
};

export interface EvidenceQualityReportEntry {
  ac: string;
  verdict: EvidenceQualityVerdict;
  reasoning: string;
  evidenceRef?: string;
}

export interface EvidenceQualityOverride {
  ac: string;
  humanVerdict: EvidenceQualityVerdict;
  llmVerdict: EvidenceQualityVerdict;
  overriddenAt: string;
}

export interface EvidenceQualityReport {
  acVerdicts: EvidenceQualityReportEntry[];
  overallScore: number;
  overrides: EvidenceQualityOverride[];
}

export type RecipeQualityVerdict = 'pass' | 'warn' | 'fail';
export type RecipeQualityDimensionStatus = 'pass' | 'warn' | 'fail' | 'not_applicable';
export type RecipeQualityEvidenceMode =
  | 'logs'
  | 'state'
  | 'trace'
  | 'screenshot'
  | 'mixed'
  | 'unknown';
export type RecipeQualityArtifactSource =
  | 'worker'
  | 'gateway'
  | 'fallback:recipe-coverage'
  | 'fallback:recipe-json'
  | 'fallback:report'
  | 'fallback:missing';

export interface RecipeQualityCompactProjection {
  verdict: 'PASS' | 'WARN' | 'FAIL';
  reasons: string[];
  better_version_guidance: string[];
}

export interface RecipeQualityDimensionResult {
  status: RecipeQualityDimensionStatus;
  reason: string;
  evidence: string[];
}

export interface RecipeQualityFinding {
  code: string;
  message: string;
  dimension?: string;
  evidence?: string[];
}

export interface RecipeQualityTrainingFields {
  farm?: string;
  project?: string;
  flow_type?: FlowType;
  task_type?: string;
  claim_is_visual?: boolean;
  proof_mode?: RecipeQualityEvidenceMode;
  anti_patterns?: string[];
  good_patterns?: string[];
}

export interface RecipeQualityArtifactMeta {
  producer: RecipeQualityArtifactSource;
  fallback_used: boolean;
  fallback_source?: Exclude<RecipeQualityArtifactSource, 'worker' | 'gateway'>;
  legacy_task: boolean;
  artifact_required: boolean;
  source_signals: string[];
}

export interface RecipeQualityArtifact {
  version: 1;
  verdict: RecipeQualityVerdict;
  compact: RecipeQualityCompactProjection;
  dimensions: Record<string, RecipeQualityDimensionResult>;
  structural_findings: RecipeQualityFinding[];
  contextual_findings: RecipeQualityFinding[];
  suggested_recipe_delta: string[];
  training_fields: RecipeQualityTrainingFields;
  meta: RecipeQualityArtifactMeta;
}

export interface RecipeQualitySignal {
  runId?: string;
  semantic: 'good' | 'ok' | 'bad' | 'unknown';
  score?: number | null;
  source:
    | 'recipe-quality'
    | 'human-grade'
    | 'recipe-coverage'
    | 'recipe-json'
    | 'report'
    | 'missing';
  reasoning: string;
}

// Recipe contracts include run evidence and recipe-run artifacts used by recipe UI.
export type {
  EvidenceManifestEntry,
  EvidenceManifestStandalone,
  LiveRecipeContext,
  LiveRecipeSelectionReason,
  LiveRecipeSource,
  RecipeRunArtifactGroup,
  RecipeRunArtifactGroupKind,
  RecipeRunArtifactGroupStatus,
} from './runs.js';
export {
  hasLiveRecipeEvidence,
  LIVE_RECIPE_EVIDENCE_FILES,
  LIVE_RECIPE_EVIDENCE_PURPOSES,
} from './runs.js';
