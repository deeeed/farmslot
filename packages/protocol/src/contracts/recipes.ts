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

export const RECIPE_QUALITY_ARTIFACT_VERSION = 1;

// Runtime enum tuples are the source of truth for JSON validation and derived
// TypeScript unions; type-only unions disappear after compile.
export const RECIPE_QUALITY_VERDICTS = ['pass', 'warn', 'fail'] as const;
export const RECIPE_QUALITY_DIMENSION_STATUSES = [
  'pass',
  'warn',
  'fail',
  'not_applicable',
] as const;
export const RECIPE_QUALITY_PROOF_MODES = [
  'logs',
  'state',
  'trace',
  'screenshot',
  'mixed',
  'unknown',
] as const;
export const RECIPE_QUALITY_ARTIFACT_SOURCES = [
  'worker',
  'gateway',
  'fallback:recipe-coverage',
  'fallback:recipe-json',
  'fallback:report',
  'fallback:missing',
] as const;
export const RECIPE_QUALITY_FALLBACK_SOURCES = [
  'fallback:recipe-coverage',
  'fallback:recipe-json',
  'fallback:report',
  'fallback:missing',
] as const;

const RECIPE_QUALITY_FLOW_TYPES = [
  'fix-bug',
  'review-pr',
  'dev',
  'pr-complete',
  'merge-main',
] as const;

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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecipeQualityFinding(value: unknown): value is RecipeQualityFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  if (typeof finding.code !== 'string' || typeof finding.message !== 'string') return false;
  if (finding.dimension != null && typeof finding.dimension !== 'string') return false;
  if (finding.evidence != null && !isStringArray(finding.evidence)) return false;
  return true;
}

function isRecipeQualityDimensions(value: unknown): value is RecipeQualityArtifact['dimensions'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((dimension) => {
    if (!dimension || typeof dimension !== 'object' || Array.isArray(dimension)) return false;
    const result = dimension as Record<string, unknown>;
    return (
      RECIPE_QUALITY_DIMENSION_STATUSES.includes(result.status as RecipeQualityDimensionStatus) &&
      typeof result.reason === 'string' &&
      isStringArray(result.evidence)
    );
  });
}

function isRecipeQualityTrainingFields(
  value: unknown,
): value is RecipeQualityArtifact['training_fields'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  if (fields.farm != null && typeof fields.farm !== 'string') return false;
  if (fields.project != null && typeof fields.project !== 'string') return false;
  if (
    fields.flow_type != null &&
    !RECIPE_QUALITY_FLOW_TYPES.includes(String(fields.flow_type) as FlowType)
  )
    return false;
  if (fields.task_type != null && typeof fields.task_type !== 'string') return false;
  if (fields.claim_is_visual != null && typeof fields.claim_is_visual !== 'boolean') return false;
  if (
    fields.proof_mode != null &&
    !RECIPE_QUALITY_PROOF_MODES.includes(String(fields.proof_mode) as RecipeQualityEvidenceMode)
  )
    return false;
  if (fields.anti_patterns != null && !isStringArray(fields.anti_patterns)) return false;
  if (fields.good_patterns != null && !isStringArray(fields.good_patterns)) return false;
  return true;
}

function isRecipeQualityMeta(value: unknown): value is RecipeQualityArtifact['meta'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  if (!RECIPE_QUALITY_ARTIFACT_SOURCES.includes(meta.producer as RecipeQualityArtifactSource))
    return false;
  if (typeof meta.fallback_used !== 'boolean') return false;
  if (typeof meta.legacy_task !== 'boolean') return false;
  if (typeof meta.artifact_required !== 'boolean') return false;
  if (!isStringArray(meta.source_signals)) return false;
  if (
    meta.fallback_source != null &&
    !RECIPE_QUALITY_FALLBACK_SOURCES.includes(
      meta.fallback_source as Exclude<RecipeQualityArtifactSource, 'worker' | 'gateway'>,
    )
  )
    return false;
  return true;
}

export function isRecipeQualityArtifact(value: unknown): value is RecipeQualityArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  if (artifact.version !== RECIPE_QUALITY_ARTIFACT_VERSION) return false;
  if (!RECIPE_QUALITY_VERDICTS.includes(artifact.verdict as RecipeQualityVerdict)) return false;
  if (!artifact.compact || typeof artifact.compact !== 'object' || Array.isArray(artifact.compact))
    return false;
  const compact = artifact.compact as Record<string, unknown>;
  if (!['PASS', 'WARN', 'FAIL'].includes(String(compact.verdict))) return false;
  if (!isStringArray(compact.reasons) || !isStringArray(compact.better_version_guidance))
    return false;
  if (!isRecipeQualityDimensions(artifact.dimensions)) return false;
  if (
    !Array.isArray(artifact.structural_findings) ||
    !artifact.structural_findings.every(isRecipeQualityFinding)
  )
    return false;
  if (
    !Array.isArray(artifact.contextual_findings) ||
    !artifact.contextual_findings.every(isRecipeQualityFinding)
  )
    return false;
  if (!isStringArray(artifact.suggested_recipe_delta)) return false;
  if (!isRecipeQualityTrainingFields(artifact.training_fields)) return false;
  if (!isRecipeQualityMeta(artifact.meta)) return false;
  return true;
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
