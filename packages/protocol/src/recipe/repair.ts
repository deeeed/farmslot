import {
  addFinding,
  createContext,
  finishResult,
  isNonEmptyString,
  isRecord,
  isRelativeArtifactPath,
  type RecipeValidationResult,
} from './common.js';
import { digestRecipeDocument } from './digest.js';
import {
  type EvidenceMomentRef,
  normalizeRecipeClaimId,
  type RecipeClaimDeclaration,
  type RecipeClaimEvidence,
  type RecipeClaimProofMode,
  validateRecipeClaimDeclarations,
} from './evidence.js';

/** The publication gate action that returns qualified Issues to the retained worker. */
export const SEND_BACK_TO_AGENT_ACTION = 'send-feedback';

/** Gateway-written worker input; the run store keeps its authoritative digest. */
export const RECIPE_REPAIR_SCOPE_TASK_PATH = 'artifacts/visual-repair-scope.json';
/** Checked scope copy retained in the fresh attempt. */
export const RECIPE_REPAIR_SCOPE_FILE = 'repair-scope.json';
/** Engine-owned claim-to-source selection retained in the fresh attempt. */
export const RECIPE_REPAIR_SELECTION_FILE = 'repair-selection.json';

/** An original recorded execution that non-rejected criteria may keep. */
export interface RecipeRepairSource {
  recipeRunId: string;
  closureIdentity: string;
  /** Task-relative root of the retained package. */
  artifactRoot: string;
  /** Commit the source was recorded at; applicability diffs start here. */
  headSha: string;
}

/** A qualified Issue frozen from its gateway receipt. */
export interface RecipeRepairRejection {
  claimId: string;
  /** Original proof mode; fresh proof must not weaken it. */
  proofMode: RecipeClaimProofMode;
  receiptId: string;
  reason: string;
  recipeRunId: string;
  closureIdentity: string;
  reviewedFiles: { path: string; digest: string }[];
  moments: EvidenceMomentRef[];
}

export interface RecipeRepairScope {
  schemaVersion: 1;
  repairId: string;
  runId: string;
  generation: number;
  decisionId: string;
  packageHash: string;
  packageHeadSha: string;
  reviewBaseSha: string;
  /** Retained review loop whose existing worker-fix budget pays for this repair. */
  reviewId: string;
  /** Agent context owning the retained worker. */
  workerContextId: string;
  /** Task-relative path of the separate repair recipe. The main task recipe is unchanged. */
  repairRecipe: string;
  /** The full task registration. */
  claims: RecipeClaimDeclaration[];
  sources: RecipeRepairSource[];
  /** Every non-rejected registered criterion and the original source it currently selects. */
  retained: { claimId: string; recipeRunId: string }[];
  rejected: RecipeRepairRejection[];
}

export type RecipeRepairClaimSource =
  | { claimId: string; source: 'fresh' }
  | { claimId: string; source: 'retained'; recipeRunId: string; closureIdentity: string };

export interface RecipeRepairSelection {
  schemaVersion: 1;
  repairId: string;
  scopeDigest: string;
  /** The fresh execution. */
  recipeRunId: string;
  claims: RecipeRepairClaimSource[];
}

/** One identity per package and sorted rejection receipts, so retries reuse the same charge. */
export function recipeRepairId(input: {
  runId: string;
  packageHash: string;
  receiptIds: readonly string[];
}): string {
  const digest = digestRecipeDocument({
    runId: input.runId,
    packageHash: input.packageHash,
    receiptIds: [...input.receiptIds].sort(),
  });
  return `repair-${digest.slice('sha256:'.length, 'sha256:'.length + 24)}`;
}

export function recipeRepairScopeDigest(scope: RecipeRepairScope): string {
  return digestRecipeDocument(scope);
}

/** Rejected criteria always re-prove; others keep retained proof only when the fresh graph left them missing. */
export function selectRepairClaimSources(
  scope: RecipeRepairScope,
  fresh: readonly RecipeClaimEvidence[],
): RecipeRepairClaimSource[] {
  const rejected = new Set(scope.rejected.map(({ claimId }) => claimId));
  return scope.claims.map(({ id }) => {
    const claimId = normalizeRecipeClaimId(id);
    const freshClaim = fresh.find((claim) => claim.id === claimId);
    if (rejected.has(claimId) || (freshClaim && freshClaim.verdict !== 'missing'))
      return { claimId, source: 'fresh' };
    const retained = scope.retained.find((row) => row.claimId === claimId)!;
    const source = scope.sources.find((row) => row.recipeRunId === retained.recipeRunId)!;
    return {
      claimId,
      source: 'retained',
      recipeRunId: source.recipeRunId,
      closureIdentity: source.closureIdentity,
    };
  });
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
/** The ready gate's frozen package identity: a bare sha256 hex digest. */
const PACKAGE_HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40,64}$/u;
const EXECUTION = /^[A-Za-z0-9._-]+$/u;
const PROOF_MODES: readonly string[] = ['state', 'visual', 'mixed'];

function validExecutionId(value: unknown): value is string {
  return typeof value === 'string' && EXECUTION.test(value) && !['.', '..'].includes(value);
}

function validMoments(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (moment) =>
        isRecord(moment) &&
        validExecutionId(moment.recipeRunId) &&
        typeof moment.videoDigest === 'string' &&
        DIGEST.test(moment.videoDigest) &&
        Number.isInteger(moment.traceIndex) &&
        Number(moment.traceIndex) >= 0,
    )
  );
}

function validFiles(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        isRecord(file) &&
        isNonEmptyString(file.path) &&
        isRelativeArtifactPath(file.path) &&
        typeof file.digest === 'string' &&
        DIGEST.test(file.digest),
    )
  );
}

export function validateRecipeRepairScope(value: unknown): RecipeValidationResult {
  const context = createContext();
  const issue = (path: string, message: string) =>
    addFinding(context, 'error', 'recipe.invalid_repair_scope', path, message);
  if (!isRecord(value)) {
    issue('scope', 'A repair scope must be an object.');
    return finishResult(context);
  }
  if (value.schemaVersion !== 1) issue('schemaVersion', 'Unsupported repair scope version.');
  for (const field of [
    'repairId',
    'runId',
    'decisionId',
    'reviewId',
    'workerContextId',
    'repairRecipe',
  ])
    if (!isNonEmptyString(value[field])) issue(field, `${field} is required.`);
  if (!Number.isInteger(value.generation) || Number(value.generation) < 0)
    issue('generation', 'A run generation is required.');
  if (typeof value.packageHash !== 'string' || !PACKAGE_HASH.test(value.packageHash))
    issue('packageHash', 'A frozen package digest is required.');
  for (const field of ['packageHeadSha', 'reviewBaseSha'])
    if (typeof value[field] !== 'string' || !COMMIT.test(value[field]))
      issue(field, `${field} must be a full commit.`);
  if (
    typeof value.repairRecipe === 'string' &&
    (!isRelativeArtifactPath(value.repairRecipe) || value.repairRecipe.startsWith('artifacts/'))
  )
    issue('repairRecipe', 'The repair recipe must be a task-owned relative path.');
  const declarations = validateRecipeClaimDeclarations(value.claims);
  for (const finding of declarations.findings)
    addFinding(context, finding.severity, finding.code, `claims.${finding.path}`, finding.message);
  const claims = Array.isArray(value.claims) ? value.claims.filter(isRecord) : [];
  if (!claims.length) issue('claims', 'The full task registration is required.');
  if (claims.some((claim) => claim.parentId !== undefined))
    issue('claims', 'Nested criteria cannot be repaired by claim selection.');
  const registered = claims.map((claim) => normalizeRecipeClaimId(String(claim.id)));
  const sources = Array.isArray(value.sources) ? value.sources : [];
  const sourceIds = new Set<string>();
  for (const [index, source] of sources.entries()) {
    if (
      !isRecord(source) ||
      !validExecutionId(source.recipeRunId) ||
      sourceIds.has(source.recipeRunId) ||
      typeof source.closureIdentity !== 'string' ||
      !DIGEST.test(source.closureIdentity) ||
      typeof source.artifactRoot !== 'string' ||
      !source.artifactRoot.startsWith('artifacts/') ||
      !isRelativeArtifactPath(source.artifactRoot) ||
      typeof source.headSha !== 'string' ||
      !COMMIT.test(source.headSha)
    ) {
      issue(`sources[${index}]`, 'Invalid or duplicate retained source.');
      continue;
    }
    sourceIds.add(source.recipeRunId);
  }
  if (!sources.length) issue('sources', 'At least one original source is required.');
  const rejected = Array.isArray(value.rejected) ? value.rejected : [];
  const rejectedIds = new Set<string>();
  for (const [index, row] of rejected.entries()) {
    const path = `rejected[${index}]`;
    if (
      !isRecord(row) ||
      typeof row.claimId !== 'string' ||
      !registered.includes(row.claimId) ||
      rejectedIds.has(row.claimId) ||
      !PROOF_MODES.includes(String(row.proofMode)) ||
      !isNonEmptyString(row.receiptId) ||
      !isNonEmptyString(row.reason) ||
      !validExecutionId(row.recipeRunId) ||
      !sourceIds.has(row.recipeRunId) ||
      typeof row.closureIdentity !== 'string' ||
      !DIGEST.test(row.closureIdentity) ||
      !validFiles(row.reviewedFiles) ||
      !validMoments(row.moments)
    ) {
      issue(path, 'Invalid, unregistered or duplicate rejected criterion.');
      continue;
    }
    rejectedIds.add(row.claimId);
  }
  if (!rejected.length) issue('rejected', 'A repair requires at least one Issue.');
  const retained = Array.isArray(value.retained) ? value.retained : [];
  const retainedIds = new Set<string>();
  for (const [index, row] of retained.entries()) {
    if (
      !isRecord(row) ||
      typeof row.claimId !== 'string' ||
      !registered.includes(row.claimId) ||
      rejectedIds.has(row.claimId) ||
      retainedIds.has(row.claimId) ||
      typeof row.recipeRunId !== 'string' ||
      !sourceIds.has(row.recipeRunId)
    ) {
      issue(`retained[${index}]`, 'Invalid, rejected or duplicate retained criterion.');
      continue;
    }
    retainedIds.add(row.claimId);
  }
  if (registered.some((id) => !rejectedIds.has(id) && !retainedIds.has(id)))
    issue('retained', 'Every non-rejected criterion must name its current source.');
  if (
    isNonEmptyString(value.runId) &&
    typeof value.packageHash === 'string' &&
    value.repairId !==
      recipeRepairId({
        runId: value.runId,
        packageHash: value.packageHash,
        receiptIds: rejected.filter(isRecord).map((row) => String(row.receiptId)),
      })
  )
    issue('repairId', 'Repair identity does not bind the package and rejection receipts.');
  return finishResult(context);
}

export function isRecipeRepairScope(value: unknown): value is RecipeRepairScope {
  return validateRecipeRepairScope(value).status === 'valid';
}

/** The selection must be exactly the engine rule over the scope and the fresh claims. */
export function validateRecipeRepairSelection(
  value: unknown,
  scope: RecipeRepairScope,
  fresh: { recipeRunId: string; criteria: readonly RecipeClaimEvidence[] },
): RecipeValidationResult {
  const context = createContext();
  const issue = (path: string, message: string) =>
    addFinding(context, 'error', 'recipe.invalid_repair_selection', path, message);
  if (!isRecord(value)) {
    issue('selection', 'A repair selection must be an object.');
    return finishResult(context);
  }
  if (value.schemaVersion !== 1) issue('schemaVersion', 'Unsupported repair selection version.');
  if (value.repairId !== scope.repairId) issue('repairId', 'Selection belongs to another repair.');
  if (value.scopeDigest !== recipeRepairScopeDigest(scope))
    issue('scopeDigest', 'Selection does not bind the retained repair scope.');
  if (value.recipeRunId !== fresh.recipeRunId)
    issue('recipeRunId', 'Selection belongs to another fresh execution.');
  const registered = scope.claims.map(({ id }) => normalizeRecipeClaimId(id));
  if (
    fresh.criteria.length !== registered.length ||
    fresh.criteria.some((claim) => !registered.includes(claim.id))
  )
    issue('claims', 'The fresh execution must keep the full task registration.');
  for (const rejection of scope.rejected) {
    const claim = fresh.criteria.find(({ id }) => id === rejection.claimId);
    if (claim && claim.proofMode !== rejection.proofMode)
      issue(
        `claims.${rejection.claimId}.proofMode`,
        `Fresh proof must keep the original ${rejection.proofMode} proof mode.`,
      );
  }
  if (
    digestRecipeDocument(value.claims) !==
    digestRecipeDocument(selectRepairClaimSources(scope, fresh.criteria))
  )
    issue('claims', 'Selection differs from the engine claim-source rule.');
  return finishResult(context);
}
