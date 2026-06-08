import {
  type FamilyDiffProvenance,
  type FamilyInputCommitMetadata,
  type FamilyObservabilityArtifact,
  type FlowType,
  isFamilyDiffProvenance,
} from './runs.js';

export type EvalMediaRole =
  | 'reference-before'
  | 'reference-after'
  | 'eval-before'
  | 'eval-after'
  | 'reference-video'
  | 'eval-video'
  | 'eval-diff';

export interface EvalMedia {
  role: EvalMediaRole;
  artifact: FamilyObservabilityArtifact;
  label?: string;
  source: 'reference-pr' | 'eval-run';
  sourceRunId?: string;
  sourcePrNumber?: number;
  missingReason?: string;
}

export type EvalPackageSourceKind = 'merged-pr' | 'prior-run' | 'package' | 'git-ref';
export type EvalTaskProfile = 'fix-bug' | 'dev';

export interface TaskTemplateSelection {
  /** Project-owned worker template basename, e.g. fix-bug.md or fix-bug-v2.md. */
  fileName: string;
  /** Parsed suffix after the canonical flow prefix. null/omitted means default template. */
  variant?: string | null;
}
export type TaskTemplateSelectionSource =
  | 'explicit'
  | 'default'
  | 'implicit-interactive-fix-bug'
  | 'implicit-interactive-dev'
  | 'implicit-interactive-pr-complete';
export type EvalPackageRole = 'reference' | 'candidate' | 'control' | 'challenger';
export type ResultPackageStatus = 'draft' | 'final';
export type EvalEvidenceState = 'present' | 'missing' | 'not_applicable' | 'failed';
export type ExperimentTrialStatus = 'draft' | 'running' | 'final' | 'failed';
export type EvalMetadataValue = string | number | boolean | null;
export type EvalMetadata = Record<string, EvalMetadataValue>;

export interface EvalPackageAxisRef {
  name?: string;
  version?: string;
  path?: string;
  hash?: string;
  ref?: string;
}

export type TemplateProvenanceSource =
  | 'current-project'
  | 'project-commit'
  | 'external'
  | 'generated';

export interface TemplateProvenance {
  kind: 'task-template';
  flowType: FlowType;
  taskProfile?: EvalTaskProfile;
  project: string;
  role: 'worker' | 'orchestrator' | 'eval-candidate';
  templatePath: string;
  templateName: string;
  /** Parsed worker-template version suffix. null/omitted means the canonical default. */
  templateVariant?: string | null;
  /** True when this came from <flow>.md instead of a suffixed version. */
  templateIsDefault?: boolean;
  /** How the worker template was selected for this run. */
  templateSelectionSource?: TaskTemplateSelectionSource;
  /** Operator/debug-facing reason for implicit or default template selection. */
  templateSelectionReason?: string;
  contentHash: string;
  projectRepoPath?: string;
  projectRepoHeadSha?: string;
  projectRepoDirty?: boolean;
  farmslotHeadSha?: string;
  source: TemplateProvenanceSource;
  renderedAt: string;
}

export interface EvalPackageAxes {
  template?: EvalPackageAxisRef;
  prompt?: EvalPackageAxisRef;
  harness?: EvalPackageAxisRef;
  baseRecipe?: EvalPackageAxisRef;
  review?: EvalPackageAxisRef;
  runner?: EvalPackageAxisRef;
  model?: EvalPackageAxisRef;
  actualModel?: EvalPackageAxisRef;
}

export type EvalHarnessLifecycleStatus = 'pending' | 'passed' | 'failed' | 'skipped';

export interface EvalHarnessLifecycle {
  source?: string;
  requestedRef?: string;
  resolvedSha?: string;
  adapter?: string;
  manifestPath?: string;
  installStatus?: EvalHarnessLifecycleStatus;
  verifyStatus?: EvalHarnessLifecycleStatus;
  cleanupStatus?: EvalHarnessLifecycleStatus;
  installLogPath?: string;
  verifyLogPath?: string;
  cleanupLogPath?: string;
  updatedAt?: string;
}

export interface EvalProductRef {
  requestedRef: string;
  source: 'eval-reference' | 'eval-candidate';
}

export type EvalPackageSource =
  | {
      kind: 'merged-pr';
      repo: string;
      prNumber: number;
      url?: string;
      title?: string;
      baseRef?: string;
      baseSha?: string;
      headRef?: string;
      headSha?: string;
      mergedAt?: string;
      mergeCommitSha?: string;
    }
  | {
      kind: 'prior-run';
      runId: string;
      familyId?: string;
      taskFile?: string | null;
    }
  | {
      kind: 'package';
      packageId: string;
      packageHash?: string;
      packagePath?: string;
    }
  | {
      kind: 'git-ref';
      ref: string;
      repository?: string;
      baseRef?: string;
      baseSha?: string;
      headRef?: string;
      headSha?: string;
    };

export type EvalPackageSourceBacklink =
  | { kind: 'run'; runId: string }
  | { kind: 'family'; familyId: string }
  | { kind: 'github-pr'; repo: string; prNumber: number; url?: string }
  | { kind: 'package'; packageId: string; packagePath?: string }
  | { kind: 'git-ref'; ref: string; repository?: string; headSha?: string };

export interface EvalDatasetItem {
  datasetItemId: string;
  label?: string;
  source: EvalPackageSource;
  taskProfile: EvalTaskProfile;
  objective?: string;
  objectiveHash?: string;
  metadata?: EvalMetadata;
}

export interface EvalDatasetManifest {
  version: 1;
  kind: 'eval-dataset';
  datasetId: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  label: string;
  description?: string;
  items: EvalDatasetItem[];
  metadata?: EvalMetadata;
}

export type EvalScorerConfigKind =
  | 'human'
  | 'heuristic'
  | 'llm-judge'
  | 'deterministic'
  | 'external-ref';

export interface EvalScorerConfigRef {
  scorerId: string;
  label?: string;
  kind: EvalScorerConfigKind;
  configRef?: string;
  rubricId?: string;
  rubricVersion?: string;
  metadata?: EvalMetadata;
}

export interface EvalSuiteCandidateStrategyRef {
  strategyId: string;
  label: string;
  axes?: EvalPackageAxes;
  /** Optional in suite drafts; materialization computes the required CandidateStrategy fingerprint. */
  candidateStrategyFingerprint?: string;
  metadata?: EvalMetadata;
}

export interface EvalSuiteDraftManifest {
  version: 1;
  kind: 'eval-suite-draft';
  suiteId: string;
  suiteKey: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  label: string;
  description?: string;
  datasetId: string;
  datasetItemIds: string[];
  candidateStrategies: EvalSuiteCandidateStrategyRef[];
  scorerConfigRefs: EvalScorerConfigRef[];
  metadata?: EvalMetadata;
}

export interface EvalEvidenceRequirement {
  id: string;
  label: string;
  state: EvalEvidenceState;
  artifactPaths?: string[];
  note?: string;
}

export interface ResultPackageMetrics {
  durationMs?: number;
  costEstimate?: number;
  sessionTurns?: number;
  sessionInputTokens?: number;
  sessionOutputTokens?: number;
  sessionTotalTokens?: number;
}

export interface ResultPackageManifest {
  version: 1;
  kind: 'result-package';
  packageId: string;
  packageHash: string;
  status: ResultPackageStatus;
  createdAt: string;
  finalizedAt?: string;
  project: string;
  familyId: string;
  objectiveHash: string;
  taskProfile: EvalTaskProfile;
  source: EvalPackageSource;
  productRef?: EvalProductRef;
  runId?: string;
  role?: EvalPackageRole;
  baseline?: FamilyInputCommitMetadata;
  head?: FamilyInputCommitMetadata;
  diff: FamilyDiffProvenance;
  axes: EvalPackageAxes;
  visualEvidence: EvalMedia[];
  validationEvidence: FamilyObservabilityArtifact[];
  reviewEvidence: FamilyObservabilityArtifact[];
  outcomeClaims: string[];
  evidenceRequirements?: EvalEvidenceRequirement[];
  metrics?: ResultPackageMetrics;
  templateProvenance?: TemplateProvenance;
  harnessLifecycle?: EvalHarnessLifecycle;
  missingData: string[];
}

export interface EvalRubricManifest {
  taskProfile: EvalTaskProfile;
  rubricId: string;
  rubricVersion: string;
  requiredEvidence: EvalEvidenceRequirement[];
}

export interface EvalCase {
  caseId: string;
  source: EvalPackageSource;
  taskProfile: EvalTaskProfile;
  objectiveHash: string;
  referencePackageId: string;
  referencePackageHash: string;
  referencePackagePath: string;
  label?: string;
  metadata?: EvalMetadata;
}

export interface CandidateStrategy {
  strategyId: string;
  label: string;
  axes?: EvalPackageAxes;
  candidateStrategyFingerprint: string;
  metadata?: EvalMetadata;
}

export interface ExperimentTrial {
  trialId: string;
  strategyId: string;
  caseId: string;
  status: ExperimentTrialStatus;
  runId?: string;
  packageId?: string;
  packageHash?: string;
  packagePath?: string;
  startedAt?: string;
  completedAt?: string;
  missingData: string[];
}

export interface EvalExperimentManifest {
  version: 1;
  kind: 'eval-experiment';
  experimentId: string;
  experimentKey: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  familyId: string;
  datasetId?: string;
  datasetItemId?: string;
  case: EvalCase;
  rubric: EvalRubricManifest;
  candidateStrategies: CandidateStrategy[];
  trials: ExperimentTrial[];
  missingData: string[];
  annotations?: Array<{ author?: string; createdAt: string; note: string }>;
}

export interface ResultPackageProjection {
  caseId?: string;
  strategyId?: string;
  trialId?: string;
  role: EvalPackageRole;
  label?: string;
  packageId: string;
  packageHash: string;
  packagePath: string;
  runId?: string;
  source?: EvalPackageSource;
  sourceBacklinks?: EvalPackageSourceBacklink[];
  candidateStrategyFingerprint?: string;
  axes?: EvalPackageAxes;
  status: ResultPackageStatus;
  diff: FamilyDiffProvenance;
  metrics?: ResultPackageMetrics;
  visualEvidenceCount: number;
  validationEvidenceCount: number;
  reviewEvidenceCount: number;
  missingData: string[];
}

export interface EvalExperimentProjection {
  experimentId: string;
  experimentKey: string;
  familyId: string;
  taskProfile: EvalTaskProfile;
  rubricId: string;
  rubricVersion: string;
  case: EvalCase;
  candidateStrategies: CandidateStrategy[];
  trials: ExperimentTrial[];
  packages?: ResultPackageProjection[];
  missingData: string[];
  manifestPath: string;
}

function isEvalMediaRole(value: unknown): value is EvalMediaRole {
  return (
    value === 'reference-before' ||
    value === 'reference-after' ||
    value === 'eval-before' ||
    value === 'eval-after' ||
    value === 'reference-video' ||
    value === 'eval-video' ||
    value === 'eval-diff'
  );
}

function isEvalMedia(value: unknown): value is EvalMedia {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    isEvalMediaRole(rec.role) &&
    typeof rec.source === 'string' &&
    (rec.source === 'reference-pr' || rec.source === 'eval-run') &&
    isFamilyObservabilityArtifactShallow(rec.artifact) &&
    (rec.label == null || typeof rec.label === 'string') &&
    (rec.sourceRunId == null || typeof rec.sourceRunId === 'string') &&
    (rec.sourcePrNumber == null ||
      (typeof rec.sourcePrNumber === 'number' && Number.isFinite(rec.sourcePrNumber))) &&
    (rec.missingReason == null || typeof rec.missingReason === 'string')
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isEvalPackageAxisRef(value: unknown): value is EvalPackageAxisRef {
  if (!isPlainRecord(value)) return false;
  return (
    isOptionalString(value.name) &&
    isOptionalString(value.version) &&
    isOptionalString(value.path) &&
    isOptionalString(value.hash) &&
    isOptionalString(value.ref)
  );
}

function isTemplateProvenanceSource(value: unknown): value is TemplateProvenanceSource {
  return (
    value === 'current-project' ||
    value === 'project-commit' ||
    value === 'external' ||
    value === 'generated'
  );
}

function isTemplateProvenance(value: unknown): value is TemplateProvenance {
  if (!isPlainRecord(value)) return false;
  return (
    value.kind === 'task-template' &&
    typeof value.flowType === 'string' &&
    (value.taskProfile == null || isEvalTaskProfile(value.taskProfile)) &&
    typeof value.project === 'string' &&
    (value.role === 'worker' || value.role === 'orchestrator' || value.role === 'eval-candidate') &&
    typeof value.templatePath === 'string' &&
    typeof value.templateName === 'string' &&
    isOptionalString(value.templateVariant) &&
    (value.templateIsDefault === undefined || typeof value.templateIsDefault === 'boolean') &&
    typeof value.contentHash === 'string' &&
    isOptionalString(value.projectRepoPath) &&
    isOptionalString(value.projectRepoHeadSha) &&
    (value.projectRepoDirty == null || typeof value.projectRepoDirty === 'boolean') &&
    isOptionalString(value.farmslotHeadSha) &&
    isTemplateProvenanceSource(value.source) &&
    typeof value.renderedAt === 'string'
  );
}

export function isEvalPackageAxes(value: unknown): value is EvalPackageAxes {
  if (!isPlainRecord(value)) return false;
  return (
    (value.template == null || isEvalPackageAxisRef(value.template)) &&
    (value.prompt == null || isEvalPackageAxisRef(value.prompt)) &&
    (value.harness == null || isEvalPackageAxisRef(value.harness)) &&
    (value.baseRecipe == null || isEvalPackageAxisRef(value.baseRecipe)) &&
    (value.review == null || isEvalPackageAxisRef(value.review)) &&
    (value.runner == null || isEvalPackageAxisRef(value.runner)) &&
    (value.model == null || isEvalPackageAxisRef(value.model)) &&
    (value.actualModel == null || isEvalPackageAxisRef(value.actualModel))
  );
}

function isEvalHarnessLifecycleStatus(value: unknown): value is EvalHarnessLifecycleStatus {
  return value === 'pending' || value === 'passed' || value === 'failed' || value === 'skipped';
}

function isEvalHarnessLifecycle(value: unknown): value is EvalHarnessLifecycle {
  if (!isPlainRecord(value)) return false;
  return (
    isOptionalString(value.source) &&
    isOptionalString(value.requestedRef) &&
    isOptionalString(value.resolvedSha) &&
    isOptionalString(value.adapter) &&
    isOptionalString(value.manifestPath) &&
    (value.installStatus == null || isEvalHarnessLifecycleStatus(value.installStatus)) &&
    (value.verifyStatus == null || isEvalHarnessLifecycleStatus(value.verifyStatus)) &&
    (value.cleanupStatus == null || isEvalHarnessLifecycleStatus(value.cleanupStatus)) &&
    isOptionalString(value.installLogPath) &&
    isOptionalString(value.verifyLogPath) &&
    isOptionalString(value.cleanupLogPath) &&
    isOptionalString(value.updatedAt)
  );
}

function isEvalProductRef(value: unknown): value is EvalProductRef {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.requestedRef === 'string' &&
    (value.source === 'eval-reference' || value.source === 'eval-candidate')
  );
}

function isEvalTaskProfile(value: unknown): value is EvalTaskProfile {
  return value === 'fix-bug' || value === 'dev';
}

function isEvalPackageRole(value: unknown): value is EvalPackageRole {
  return (
    value === 'reference' || value === 'candidate' || value === 'control' || value === 'challenger'
  );
}

function isEvalEvidenceState(value: unknown): value is EvalEvidenceState {
  return (
    value === 'present' || value === 'missing' || value === 'not_applicable' || value === 'failed'
  );
}

function isEvalEvidenceRequirement(value: unknown): value is EvalEvidenceRequirement {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    isEvalEvidenceState(value.state) &&
    (value.artifactPaths == null ||
      (Array.isArray(value.artifactPaths) &&
        value.artifactPaths.every((entry) => typeof entry === 'string'))) &&
    isOptionalString(value.note)
  );
}

function isEvalPackageSource(value: unknown): value is EvalPackageSource {
  if (!isPlainRecord(value)) return false;
  if (value.kind === 'merged-pr') {
    return (
      typeof value.repo === 'string' &&
      typeof value.prNumber === 'number' &&
      Number.isFinite(value.prNumber) &&
      isOptionalString(value.url) &&
      isOptionalString(value.title) &&
      isOptionalString(value.baseRef) &&
      isOptionalString(value.baseSha) &&
      isOptionalString(value.headRef) &&
      isOptionalString(value.headSha) &&
      isOptionalString(value.mergedAt) &&
      isOptionalString(value.mergeCommitSha)
    );
  }
  if (value.kind === 'prior-run') {
    return (
      typeof value.runId === 'string' &&
      isOptionalString(value.familyId) &&
      isOptionalString(value.taskFile)
    );
  }
  if (value.kind === 'package') {
    return (
      typeof value.packageId === 'string' &&
      isOptionalString(value.packageHash) &&
      isOptionalString(value.packagePath)
    );
  }
  if (value.kind === 'git-ref') {
    return (
      typeof value.ref === 'string' &&
      isOptionalString(value.repository) &&
      isOptionalString(value.baseRef) &&
      isOptionalString(value.baseSha) &&
      isOptionalString(value.headRef) &&
      isOptionalString(value.headSha)
    );
  }
  return false;
}

function isEvalMetadata(value: unknown): value is EvalMetadata {
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      entry == null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean',
  );
}

function isEvalDatasetItem(value: unknown): value is EvalDatasetItem {
  if (!isPlainRecord(value)) return false;
  return (
    isNonEmptyString(value.datasetItemId) &&
    isOptionalString(value.label) &&
    isEvalPackageSource(value.source) &&
    isEvalTaskProfile(value.taskProfile) &&
    isOptionalString(value.objective) &&
    isOptionalString(value.objectiveHash) &&
    (value.metadata == null || isEvalMetadata(value.metadata))
  );
}

export function isEvalDatasetManifest(value: unknown): value is EvalDatasetManifest {
  if (!isPlainRecord(value)) return false;
  if (value.version !== 1 || value.kind !== 'eval-dataset') return false;
  // Datasets are reusable input catalogs, so their metadata stays intentionally loose.
  // Runtime payload-key guards apply only to suite/scorer planning refs below.
  return (
    isNonEmptyString(value.datasetId) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isNonEmptyString(value.project) &&
    isNonEmptyString(value.label) &&
    isOptionalString(value.description) &&
    Array.isArray(value.items) &&
    value.items.every(isEvalDatasetItem) &&
    (value.metadata == null || isEvalMetadata(value.metadata))
  );
}

function isEvalScorerConfigKind(value: unknown): value is EvalScorerConfigKind {
  return (
    value === 'human' ||
    value === 'heuristic' ||
    value === 'llm-judge' ||
    value === 'deterministic' ||
    value === 'external-ref'
  );
}

// Suite/scorer refs are plans, not results: reject score values, verdicts, pass/fail booleans, and report/export pointers.
const EVAL_RESULT_PAYLOAD_KEYS = new Set([
  'value',
  'score',
  'scoreValue',
  'verdict',
  'passed',
  'reportPath',
  'exportPath',
]);

function hasEvalResultPayloadKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => EVAL_RESULT_PAYLOAD_KEYS.has(key));
}

function hasEvalResultPayloadKeysDeep(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasEvalResultPayloadKeysDeep);
  if (!isPlainRecord(value)) return false;
  if (hasEvalResultPayloadKeys(value)) return true;
  return Object.values(value).some(hasEvalResultPayloadKeysDeep);
}

export function isEvalScorerConfigRef(value: unknown): value is EvalScorerConfigRef {
  if (!isPlainRecord(value)) return false;
  if (hasEvalResultPayloadKeysDeep(value)) return false;
  if (value.metadata != null) {
    if (!isEvalMetadata(value.metadata)) return false;
  }
  return (
    isNonEmptyString(value.scorerId) &&
    isOptionalString(value.label) &&
    isEvalScorerConfigKind(value.kind) &&
    isOptionalString(value.configRef) &&
    isOptionalString(value.rubricId) &&
    isOptionalString(value.rubricVersion)
  );
}

function isEvalSuiteCandidateStrategyRef(value: unknown): value is EvalSuiteCandidateStrategyRef {
  if (!isPlainRecord(value)) return false;
  if (hasEvalResultPayloadKeysDeep(value)) return false;
  if (value.metadata != null) {
    if (!isEvalMetadata(value.metadata)) return false;
  }
  return (
    isNonEmptyString(value.strategyId) &&
    isNonEmptyString(value.label) &&
    (value.axes == null || isEvalPackageAxes(value.axes)) &&
    isOptionalString(value.candidateStrategyFingerprint)
  );
}

export function isEvalSuiteDraftManifest(value: unknown): value is EvalSuiteDraftManifest {
  if (!isPlainRecord(value)) return false;
  if (value.version !== 1 || value.kind !== 'eval-suite-draft') return false;
  if (hasEvalResultPayloadKeysDeep(value)) return false;
  if (value.metadata != null) {
    if (!isEvalMetadata(value.metadata)) return false;
  }
  return (
    isNonEmptyString(value.suiteId) &&
    isNonEmptyString(value.suiteKey) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isNonEmptyString(value.project) &&
    isNonEmptyString(value.label) &&
    isOptionalString(value.description) &&
    isNonEmptyString(value.datasetId) &&
    Array.isArray(value.datasetItemIds) &&
    value.datasetItemIds.every(isNonEmptyString) &&
    Array.isArray(value.candidateStrategies) &&
    value.candidateStrategies.every(isEvalSuiteCandidateStrategyRef) &&
    Array.isArray(value.scorerConfigRefs) &&
    value.scorerConfigRefs.every(isEvalScorerConfigRef)
  );
}

function isResultPackageMetrics(value: unknown): value is ResultPackageMetrics {
  if (!isPlainRecord(value)) return false;
  const validOptionalNumber = (candidate: unknown) =>
    candidate == null ||
    (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0);
  return (
    validOptionalNumber(value.durationMs) &&
    validOptionalNumber(value.costEstimate) &&
    validOptionalNumber(value.sessionTurns) &&
    validOptionalNumber(value.sessionInputTokens) &&
    validOptionalNumber(value.sessionOutputTokens) &&
    validOptionalNumber(value.sessionTotalTokens)
  );
}

function isFamilyObservabilityArtifactShallow(
  value: unknown,
): value is FamilyObservabilityArtifact {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.runId === 'string' &&
    typeof value.familyId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.purpose === 'string' &&
    (value.source === 'artifact-manifest' ||
      value.source === 'step-output' ||
      value.source === 'task-artifact' ||
      value.source === 'task-input' ||
      value.source === 'inherited-context' ||
      value.source === 'recovered-provenance')
  );
}

export function isResultPackageManifest(value: unknown): value is ResultPackageManifest {
  if (!isPlainRecord(value)) return false;
  if (value.version !== 1 || value.kind !== 'result-package') return false;
  if (typeof value.packageId !== 'string' || typeof value.packageHash !== 'string') return false;
  if (value.status !== 'draft' && value.status !== 'final') return false;
  if (
    typeof value.createdAt !== 'string' ||
    (value.status === 'final' && typeof value.finalizedAt !== 'string')
  )
    return false;
  if (value.finalizedAt != null && typeof value.finalizedAt !== 'string') return false;
  if (
    typeof value.project !== 'string' ||
    typeof value.familyId !== 'string' ||
    typeof value.objectiveHash !== 'string'
  )
    return false;
  if (!isEvalTaskProfile(value.taskProfile) || !isEvalPackageSource(value.source)) return false;
  if (value.productRef != null && !isEvalProductRef(value.productRef)) return false;
  if (!isFamilyDiffProvenance(value.diff) || !isEvalPackageAxes(value.axes)) return false;
  if (value.runId != null && typeof value.runId !== 'string') return false;
  if (value.role != null && !isEvalPackageRole(value.role)) return false;
  if (value.baseline != null && !isPlainRecord(value.baseline)) return false;
  if (value.head != null && !isPlainRecord(value.head)) return false;
  if (!Array.isArray(value.visualEvidence) || !value.visualEvidence.every(isEvalMedia))
    return false;
  if (
    !Array.isArray(value.validationEvidence) ||
    !value.validationEvidence.every(isFamilyObservabilityArtifactShallow)
  )
    return false;
  if (
    !Array.isArray(value.reviewEvidence) ||
    !value.reviewEvidence.every(isFamilyObservabilityArtifactShallow)
  )
    return false;
  if (
    !Array.isArray(value.outcomeClaims) ||
    !value.outcomeClaims.every((entry) => typeof entry === 'string')
  )
    return false;
  if (
    value.evidenceRequirements != null &&
    (!Array.isArray(value.evidenceRequirements) ||
      !value.evidenceRequirements.every(isEvalEvidenceRequirement))
  )
    return false;
  if (value.metrics != null && !isResultPackageMetrics(value.metrics)) return false;
  if (value.templateProvenance != null && !isTemplateProvenance(value.templateProvenance))
    return false;
  if (value.harnessLifecycle != null && !isEvalHarnessLifecycle(value.harnessLifecycle))
    return false;
  return (
    Array.isArray(value.missingData) &&
    value.missingData.every((entry) => typeof entry === 'string')
  );
}

function isEvalRubricManifest(value: unknown): value is EvalRubricManifest {
  if (!isPlainRecord(value)) return false;
  return (
    isEvalTaskProfile(value.taskProfile) &&
    typeof value.rubricId === 'string' &&
    typeof value.rubricVersion === 'string' &&
    Array.isArray(value.requiredEvidence) &&
    value.requiredEvidence.every(isEvalEvidenceRequirement)
  );
}

function isEvalCase(value: unknown): value is EvalCase {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.caseId === 'string' &&
    isEvalPackageSource(value.source) &&
    isEvalTaskProfile(value.taskProfile) &&
    typeof value.objectiveHash === 'string' &&
    typeof value.referencePackageId === 'string' &&
    typeof value.referencePackageHash === 'string' &&
    typeof value.referencePackagePath === 'string' &&
    isOptionalString(value.label) &&
    (value.metadata == null || isEvalMetadata(value.metadata))
  );
}

function isCandidateStrategy(value: unknown): value is CandidateStrategy {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.strategyId === 'string' &&
    typeof value.label === 'string' &&
    typeof value.candidateStrategyFingerprint === 'string' &&
    (value.axes == null || isEvalPackageAxes(value.axes)) &&
    (value.metadata == null || isEvalMetadata(value.metadata))
  );
}

function isExperimentTrialStatus(value: unknown): value is ExperimentTrialStatus {
  return value === 'draft' || value === 'running' || value === 'final' || value === 'failed';
}

function isExperimentTrial(value: unknown): value is ExperimentTrial {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.trialId === 'string' &&
    typeof value.strategyId === 'string' &&
    typeof value.caseId === 'string' &&
    isExperimentTrialStatus(value.status) &&
    isOptionalString(value.runId) &&
    isOptionalString(value.packageId) &&
    isOptionalString(value.packageHash) &&
    isOptionalString(value.packagePath) &&
    isOptionalString(value.startedAt) &&
    isOptionalString(value.completedAt) &&
    Array.isArray(value.missingData) &&
    value.missingData.every((entry) => typeof entry === 'string')
  );
}

export function isEvalExperimentManifest(value: unknown): value is EvalExperimentManifest {
  if (!isPlainRecord(value)) return false;
  if (value.version !== 1 || value.kind !== 'eval-experiment') return false;
  if (typeof value.experimentId !== 'string' || typeof value.experimentKey !== 'string')
    return false;
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return false;
  if (typeof value.project !== 'string' || typeof value.familyId !== 'string') return false;
  const evalCase = value.case;
  if (!isEvalCase(evalCase) || !isEvalRubricManifest(value.rubric)) return false;
  if (value.rubric.taskProfile !== evalCase.taskProfile) return false;
  if (value.datasetId != null && typeof value.datasetId !== 'string') return false;
  if (value.datasetItemId != null && typeof value.datasetItemId !== 'string') return false;
  if (
    !Array.isArray(value.candidateStrategies) ||
    !value.candidateStrategies.every(isCandidateStrategy)
  )
    return false;
  if (!Array.isArray(value.trials) || !value.trials.every(isExperimentTrial)) return false;
  const strategyIds = new Set(value.candidateStrategies.map((strategy) => strategy.strategyId));
  if (
    value.trials.some(
      (trial) => trial.caseId !== evalCase.caseId || !strategyIds.has(trial.strategyId),
    )
  )
    return false;
  if (
    !Array.isArray(value.missingData) ||
    !value.missingData.every((entry) => typeof entry === 'string')
  )
    return false;
  if (value.annotations != null) {
    if (!Array.isArray(value.annotations)) return false;
    for (const entry of value.annotations) {
      if (
        !isPlainRecord(entry) ||
        !isOptionalString(entry.author) ||
        typeof entry.createdAt !== 'string' ||
        typeof entry.note !== 'string'
      )
        return false;
    }
  }
  return true;
}
