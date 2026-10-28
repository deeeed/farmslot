#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { evidenceManifestArtifacts, normalizeArtifactPath } = require('./evidence-manifest.cjs');
const {
  expandedArtifactsForCommand,
  resolveWorkerTerminalArtifactPath,
  deterministicChecks,
} = require('./worker-terminal-contract.cjs');
const { SUBTASK_INDEX_REL, openSubtaskUnits } = require('./subtask-unit.cjs');
const { acceptanceContractIssues, readAcceptanceLedger } = require('./acceptance-ledger.cjs');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceProtocolRoot = path.resolve(packageRoot, '../protocol');

function isMissingWorkspaceProtocolBuild(error, output) {
  return (
    error?.code === 'ERR_MODULE_NOT_FOUND' &&
    path.basename(path.dirname(packageRoot)) === 'packages' &&
    existsSync(path.join(workspaceProtocolRoot, 'package.json')) &&
    !existsSync(path.join(workspaceProtocolRoot, output))
  );
}

let sharedRecipeQualityValidator = null;
let sharedRecipeDocumentValidator = null;
let sharedRecipeArtifactPackageValidator = null;
let sharedResolvedRecipeArtifactPath = null;
// Keep the source-checkout fallback pinned to the canonical Recipe v1 schema.
const RECIPE_SCHEMA_URL = 'https://farmslot.io/schemas/recipe-v1.schema.json';
try {
  const qualityProtocol = await import('@farmslot/protocol/contracts/recipes');
  if (typeof qualityProtocol.isRecipeQualityArtifact !== 'function') {
    throw new Error('installed @farmslot/protocol does not export isRecipeQualityArtifact');
  }
  sharedRecipeQualityValidator = qualityProtocol.isRecipeQualityArtifact;
} catch (error) {
  if (!isMissingWorkspaceProtocolBuild(error, 'dist/contracts/recipes.js')) throw error;
  // Source checkouts run this script before @farmslot/protocol has emitted dist/.
  // Keep strict local validation instead of downgrading to the historical loose gate.
  if (process.env.FARMSLOT_DEBUG_AGENT_RUNTIME) {
    console.warn(`[agent-runtime] using local RecipeQualityArtifact fallback: ${error.message}`);
  }
}
let recipeProtocol = null;
if (process.env.FARMSLOT_TEST_DISABLE_RECIPE_PROTOCOL !== '1') {
  try {
    recipeProtocol = await import('@farmslot/protocol/recipe');
  } catch (error) {
    if (!isMissingWorkspaceProtocolBuild(error, 'dist/recipe/index.js')) throw error;
    if (process.env.FARMSLOT_DEBUG_AGENT_RUNTIME) {
      console.warn(`[agent-runtime] shared Recipe v1 validator unavailable: ${error.message}`);
    }
  }
}
if (recipeProtocol) {
  for (const api of [
    'validateRecipeDocument',
    'validateRecipeArtifactPackage',
    'resolvedRecipeArtifactPath',
  ]) {
    if (typeof recipeProtocol[api] !== 'function') {
      throw new Error(`installed @farmslot/protocol does not export ${api}`);
    }
  }
  const compatibilityProbe = recipeProtocol.validateRecipeDocument({
    $schema: RECIPE_SCHEMA_URL,
    description: 'Validate the canonical Recipe v1 envelope.',
    workflow: {
      entry: 'done',
      nodes: { done: { action: 'end', status: 'pass' } },
    },
  });
  const incompatibleFinding = compatibilityProbe?.findings?.find(
    (finding) => finding?.severity === 'error',
  );
  if (incompatibleFinding) {
    throw new Error(
      `installed @farmslot/protocol rejects canonical Recipe v1 (${incompatibleFinding.code})`,
    );
  }
  sharedRecipeDocumentValidator = recipeProtocol.validateRecipeDocument;
  sharedRecipeArtifactPackageValidator = recipeProtocol.validateRecipeArtifactPackage;
  sharedResolvedRecipeArtifactPath = recipeProtocol.resolvedRecipeArtifactPath;
}

const taskDir = process.argv[2];
const rawArgs = process.argv.slice(3);
const flags = new Set();
let contractPath;
let terminalCommand;
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--contract') {
    contractPath = rawArgs[i + 1];
    i += 1;
    continue;
  }
  if (arg === '--terminal') {
    terminalCommand = rawArgs[i + 1];
    i += 1;
    continue;
  }
  flags.add(arg);
}

if (!taskDir) {
  console.error(
    'usage: check-task-artifact-contract.mjs <task-dir> [--contract path] [--terminal complete|no-change|blocked] [--require-recipe-quality-if-recipe] [--require-recipe-coverage-if-recipe] [--require-acceptance-status] [--require-learnings] [--skip-learnings]',
  );
  process.exit(2);
}

const issues = [];

function fileExists(rel) {
  try {
    return statSync(resolveTaskArtifactPath(rel)).isFile();
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return false;
  }
}

function readText(rel) {
  try {
    return readFileSync(resolveTaskArtifactPath(rel), 'utf8');
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return null;
  }
}

function isMissingPathError(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT';
}

function resolveTaskArtifactPath(rel) {
  const root = realpathSync(taskDir);
  const candidate = realpathSync(path.resolve(taskDir, publicationArtifactPath(rel)));
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${rel} resolves outside the task directory`);
  }
  return candidate;
}

function publicationArtifactPath(rel) {
  const version = terminalContract ? (terminalContract.recordedEvidenceContractVersion ?? 0) : 1;
  return resolveWorkerTerminalArtifactPath(taskDir, rel, version);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNonEmptyStringArray(value) {
  return (
    isStringArray(value) && value.length > 0 && value.every((entry) => entry.trim().length > 0)
  );
}

function isRecipeQualityArtifactFallback(value) {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!['pass', 'warn', 'fail'].includes(value.verdict)) return false;
  if (!isRecord(value.compact)) return false;
  if (!['PASS', 'WARN', 'FAIL'].includes(value.compact.verdict)) return false;
  if (!isStringArray(value.compact.reasons)) return false;
  if (!isStringArray(value.compact.better_version_guidance)) return false;
  if (!isRecord(value.dimensions)) return false;
  for (const dimension of Object.values(value.dimensions)) {
    if (!isRecord(dimension)) return false;
    if (!['pass', 'warn', 'fail', 'not_applicable'].includes(dimension.status)) return false;
    if (typeof dimension.reason !== 'string') return false;
    if (!isStringArray(dimension.evidence)) return false;
  }
  for (const key of ['structural_findings', 'contextual_findings']) {
    if (!Array.isArray(value[key])) return false;
    for (const finding of value[key]) {
      if (!isRecord(finding)) return false;
      if (typeof finding.code !== 'string' || typeof finding.message !== 'string') return false;
      if (finding.dimension != null && typeof finding.dimension !== 'string') return false;
      if (finding.evidence != null && !isStringArray(finding.evidence)) return false;
    }
  }
  if (!isStringArray(value.suggested_recipe_delta)) return false;
  if (!isRecord(value.training_fields)) return false;
  const fields = value.training_fields;
  if (fields.farm != null && typeof fields.farm !== 'string') return false;
  if (fields.project != null && typeof fields.project !== 'string') return false;
  if (
    fields.flow_type != null &&
    !['fix-bug', 'review-pr', 'dev', 'pr-complete', 'update-branch'].includes(fields.flow_type)
  )
    return false;
  if (fields.task_type != null && typeof fields.task_type !== 'string') return false;
  if (fields.claim_is_visual != null && typeof fields.claim_is_visual !== 'boolean') return false;
  if (
    fields.proof_mode != null &&
    !['logs', 'state', 'trace', 'screenshot', 'mixed', 'unknown'].includes(fields.proof_mode)
  )
    return false;
  if (fields.anti_patterns != null && !isStringArray(fields.anti_patterns)) return false;
  if (fields.good_patterns != null && !isStringArray(fields.good_patterns)) return false;
  if (!isRecord(value.meta)) return false;
  const meta = value.meta;
  if (
    ![
      'worker',
      'gateway',
      'fallback:recipe-coverage',
      'fallback:recipe-json',
      'fallback:report',
      'fallback:missing',
    ].includes(meta.producer)
  )
    return false;
  if (typeof meta.fallback_used !== 'boolean') return false;
  if (typeof meta.legacy_task !== 'boolean') return false;
  if (typeof meta.artifact_required !== 'boolean') return false;
  if (!isStringArray(meta.source_signals)) return false;
  if (
    meta.fallback_source != null &&
    ![
      'fallback:recipe-coverage',
      'fallback:recipe-json',
      'fallback:report',
      'fallback:missing',
    ].includes(meta.fallback_source)
  )
    return false;
  return true;
}

function isRecipeQualityArtifactStrict(value) {
  const validator = sharedRecipeQualityValidator ?? isRecipeQualityArtifactFallback;
  return validator(value);
}

function validateRecipeQualityArtifact() {
  const relPath = 'artifacts/recipe-quality.json';
  if (!fileExists(relPath)) return;
  const text = readText(relPath) ?? '';
  let artifact;
  try {
    artifact = JSON.parse(text);
  } catch (error) {
    issues.push(`recipe-quality.json: invalid JSON: ${error.message}`);
    return;
  }
  if (!isRecord(artifact)) {
    issues.push('recipe-quality.json: expected object');
    return;
  }
  if (!isRecipeQualityArtifactStrict(artifact)) {
    issues.push('recipe-quality.json: does not match RecipeQualityArtifact contract');
  }
}

function validateRecipeDocumentArtifact() {
  const authoredRecipe = readJsonArtifact('artifacts/recipe.json', 'recipe.json');
  if (authoredRecipe === undefined) return;
  validateRecipeDocumentValue(authoredRecipe, 'recipe.json', { skipRecipeCallResolution: true });

  let packageRoot = 'artifacts/recipe-run';
  const pointerValue = readJsonArtifact(
    'artifacts/latest-valid-recipe-run.json',
    'latest-valid-recipe-run.json',
  );
  if (pointerValue !== undefined) {
    const pointer = recipeProtocol?.sanitizeLatestValidRecipeRunPointer?.(pointerValue);
    if (!pointer) {
      issues.push(
        'latest-valid-recipe-run.json: invalid pointer or current @farmslot/protocol is unavailable',
      );
      return;
    }
    packageRoot = `artifacts/${pointer.relativeArtifactRoot}`;
  }
  // QA registers its smoke package in qa-result, independently of managed task selection.
  // This locates the existing execution; QA admission still verifies the full frozen suite.
  const qaResult = readJsonArtifact('artifacts/qa-result.json', 'qa-result.json');
  if (qaResult !== undefined) {
    const smokePackage =
      isRecord(qaResult) &&
      qaResult.version === 1 &&
      isRecord(qaResult.packages) &&
      isRecord(qaResult.smoke) &&
      typeof qaResult.smoke.caseId === 'string'
        ? qaResult.packages[qaResult.smoke.caseId]
        : undefined;
    const smokeRecipe =
      typeof smokePackage === 'string'
        ? normalizeArtifactPath(`${smokePackage}/recipe.json`, false)
        : null;
    if (!smokeRecipe) {
      issues.push(
        'qa-result.json: the registered smoke package must identify a confined relative directory',
      );
      return;
    }
    packageRoot = path.posix.dirname(smokeRecipe);
  }
  const recipe = readJsonArtifact(`${packageRoot}/recipe.json`, 'recipe-run/recipe.json');
  if (recipe === undefined) {
    issues.push(`${packageRoot}/recipe.json is missing`);
    return;
  }
  if (canonicalJson(authoredRecipe) !== canonicalJson(recipe)) {
    issues.push(`${packageRoot}/recipe.json does not match artifacts/recipe.json`);
  }
  const manifest = readJsonArtifact(
    `${packageRoot}/artifact-manifest.json`,
    'recipe-run/artifact-manifest.json',
  );
  const summary = readJsonArtifact(`${packageRoot}/summary.json`, 'recipe-run/summary.json');
  const trace = readJsonArtifact(`${packageRoot}/trace.json`, 'recipe-run/trace.json');
  const recipeResolution = readJsonArtifact(
    `${packageRoot}/recipe-resolution.json`,
    'recipe-run/recipe-resolution.json',
  );
  const resolvedRecipes = {};
  if (isRecord(recipeResolution) && Array.isArray(recipeResolution.dependencies)) {
    for (const dependency of recipeResolution.dependencies) {
      if (!isRecord(dependency)) continue;
      const artifact = resolvedRecipeArtifactPath(dependency.digest);
      if (!artifact) continue;
      const document = readJsonArtifact(`${packageRoot}/${artifact}`, `recipe-run/${artifact}`);
      if (document !== undefined) resolvedRecipes[String(dependency.digest)] = document;
    }
  }
  if (!sharedRecipeArtifactPackageValidator) {
    issues.push(
      'recipe-run package validation requires built @farmslot/protocol; build the protocol package and retry',
    );
    return;
  }
  const result = sharedRecipeArtifactPackageValidator({
    recipe,
    manifest,
    summary,
    trace,
    recipeResolution,
    resolvedRecipes,
    artifactPaths: listArtifactPaths(path.join(taskDir, packageRoot)),
  });
  for (const finding of result.findings) {
    if (finding.severity === 'error') {
      issues.push(`${finding.code} ${finding.path}: ${finding.message}`);
    }
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function resolvedRecipeArtifactPath(digest) {
  if (sharedResolvedRecipeArtifactPath) return sharedResolvedRecipeArtifactPath(digest);
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest)) return undefined;
  return `resolved-recipes/${digest.slice('sha256:'.length)}.recipe.json`;
}

function readJsonArtifact(relPath, label) {
  if (!fileExists(relPath)) return undefined;
  const text = readText(relPath) ?? '';
  try {
    return JSON.parse(text);
  } catch (error) {
    issues.push(`${label}: invalid JSON: ${error.message}`);
    return undefined;
  }
}

function validateRecipeDocumentValue(recipe, label, options) {
  if (sharedRecipeDocumentValidator) {
    const result = sharedRecipeDocumentValidator(recipe, options);
    for (const finding of result.findings) {
      if (finding.severity === 'error') {
        issues.push(`${label}: ${finding.code} ${finding.path}: ${finding.message}`);
      }
    }
    return;
  }
  if (!isRecord(recipe)) {
    issues.push(`${label}: expected object`);
    return;
  }
  const allowedRootFields = new Set([
    '$schema',
    'title',
    'description',
    'paramsSchema',
    'proofTargets',
    'workflow',
  ]);
  for (const field of Object.keys(recipe)) {
    if (!allowedRootFields.has(field))
      issues.push(`${label}: unsupported top-level field ${field}`);
  }
  if (recipe.$schema !== RECIPE_SCHEMA_URL) {
    issues.push(`${label}: $schema must equal ${RECIPE_SCHEMA_URL}`);
  }
  if (typeof recipe.description !== 'string' || !recipe.description.trim()) {
    issues.push(`${label}: description must be a non-empty string`);
  }
  if (!isRecord(recipe.workflow)) {
    issues.push(`${label}: workflow is required`);
    return;
  }
  const workflow = recipe.workflow;
  if (typeof workflow.entry !== 'string' || !workflow.entry.trim()) {
    issues.push(`${label}: workflow.entry must be a non-empty string`);
  }
  if (!isRecord(workflow.nodes) || Object.keys(workflow.nodes).length === 0) {
    issues.push(`${label}: workflow.nodes must be a non-empty object`);
    return;
  }
  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    if (!isRecord(node) || typeof node.action !== 'string' || !node.action.trim()) {
      issues.push(`${label}: workflow.nodes.${nodeId}.action must be a non-empty string`);
      continue;
    }
    if (node.action !== 'end' && (typeof node.intent !== 'string' || !node.intent.trim())) {
      issues.push(`${label}: workflow.nodes.${nodeId}.intent must be a non-empty string`);
    }
  }
}

function listArtifactPaths(root) {
  if (!existsSync(root)) return [];
  const paths = [];
  const visit = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relative);
      else if (entry.isFile()) paths.push(relative);
    }
  };
  visit(root, '');
  return paths.sort();
}

function parseManifest() {
  const relPath = publicationArtifactPath('artifacts/evidence-manifest.json');
  if (!fileExists(relPath)) return null;
  const text = readText(relPath) ?? '';
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    issues.push(`evidence-manifest.json: invalid JSON: ${error.message}`);
    return null;
  }
  const result = evidenceManifestArtifacts(manifest, path.posix.dirname(relPath), fileExists);
  issues.push(...result.issues);
  if (!result.refs) return null;
  return { manifest, refs: result.refs };
}

let terminalContract;
if (contractPath && terminalCommand && existsSync(contractPath)) {
  try {
    const baseBytes = readFileSync(contractPath, 'utf8');
    terminalContract = require('./acceptance-contract.cjs').effectiveAcceptanceContract(
      taskDir,
      JSON.parse(baseBytes),
      baseBytes,
    );
  } catch (error) {
    issues.push(`${contractPath}: invalid worker terminal contract JSON (${error.message})`);
  }
}
const isReviewTerminal = terminalContract?.flowType === 'review';
const owningFlow =
  readJsonArtifact('inputs/handoff.json', 'handoff')?.flow ?? terminalContract?.flowType;
const hasRecipe = fileExists('artifacts/recipe.json');

// A reviewer must be able to report ISSUES when worker-owned proof is invalid.
// Its terminal gate validates only the reviewer-owned feedback artifact below;
// contribution and fix flows still validate the complete proof package.
if (!isReviewTerminal) {
  const hasRecipeDecision = fileExists('artifacts/recipe-decision.json');
  const recipeDecisionText = readText('artifacts/recipe-decision.json');
  if (hasRecipeDecision) {
    try {
      const decision = JSON.parse(recipeDecisionText);
      if (!isRecord(decision)) {
        issues.push('artifacts/recipe-decision.json: expected object');
      } else {
        if (decision.version !== 1) {
          issues.push('artifacts/recipe-decision.json.version: expected 1');
        }
        if (typeof decision.required !== 'boolean') {
          issues.push('artifacts/recipe-decision.json.required: expected boolean');
        }
        if (typeof decision.reason !== 'string' || !decision.reason.trim()) {
          issues.push('artifacts/recipe-decision.json.reason: expected non-empty string');
        }
        if (!isNonEmptyStringArray(decision.actionsChecked)) {
          issues.push(
            'artifacts/recipe-decision.json.actionsChecked: expected non-empty string array',
          );
        }
        if (!isNonEmptyStringArray(decision.claims)) {
          issues.push('artifacts/recipe-decision.json.claims: expected non-empty string array');
        }
        if (decision.recipePath !== undefined && decision.recipePath !== 'artifacts/recipe.json') {
          issues.push(
            'artifacts/recipe-decision.json.recipePath: expected artifacts/recipe.json when set',
          );
        }
        if (decision.required === true && !hasRecipe) {
          issues.push(
            'artifacts/recipe-decision.json requires a recipe but artifacts/recipe.json is missing',
          );
        }
        if (decision.required === false && hasRecipe) {
          issues.push(
            'artifacts/recipe-decision.json says recipe is not required but artifacts/recipe.json exists',
          );
        }
        if (decision.required === true && decision.recipePath !== 'artifacts/recipe.json') {
          issues.push(
            'artifacts/recipe-decision.json.recipePath: required recipes must declare artifacts/recipe.json',
          );
        }
      }
    } catch (error) {
      issues.push(`artifacts/recipe-decision.json: invalid JSON (${error.message})`);
    }
  }
  validateRecipeDocumentArtifact();
  if (
    hasRecipe &&
    flags.has('--require-recipe-quality-if-recipe') &&
    !fileExists('artifacts/recipe-quality.json')
  ) {
    issues.push('recipe.json exists but artifacts/recipe-quality.json is missing');
  }
  if (
    hasRecipe &&
    flags.has('--require-recipe-coverage-if-recipe') &&
    !fileExists('artifacts/recipe-coverage.md')
  ) {
    issues.push('recipe.json exists but artifacts/recipe-coverage.md is missing');
  }
  validateRecipeQualityArtifact();

  const parsed = parseManifest();
  const coverage = readText('artifacts/recipe-coverage.md');
  if (coverage && /\|\s*(visual|mixed)\s*\|/i.test(coverage)) {
    const refCount = parsed?.refs?.size ?? 0;
    if (refCount === 0)
      issues.push(
        'recipe-coverage.md declares visual/mixed proof but evidence-manifest has no media references',
      );
  }
}

// A registered child unit is part of the parent's proof: the parent cannot
// report success while a child checklist is still running or blocked.
if (fileExists(SUBTASK_INDEX_REL)) {
  for (const { unit, status } of openSubtaskUnits(taskDir)) {
    issues.push(
      `${unit.checklist}: subtask ${unit.id} is not settled (status ${status ?? 'no signal'}) — ` +
        `finish it with ./mark sub ${unit.id} complete`,
    );
  }
}

// The acceptance ledger is the run's proof record (ADR-060): every criterion task
// init registered in inputs/handoff.json needs a verdict, and `weak` / `missing`
// fails unless the flow's terminal contract waives it.
if (
  flags.has('--require-acceptance-status') ||
  (terminalCommand === 'complete' && !isReviewTerminal)
) {
  let deferClaimVerdicts = false;
  const ledger = readAcceptanceLedger(taskDir);
  // ADR-062 Amendment 18: only the run's publication code review checks a `review` claim.
  if (
    terminalCommand === 'complete' &&
    owningFlow !== 'pr-complete' &&
    terminalContract?.publicationReview !== true
  ) {
    for (const row of Array.isArray(ledger?.criteria) ? ledger.criteria : []) {
      if (
        row?.proofMode === 'review' &&
        !terminalContract?.inheritedAcceptanceCriteria?.includes(row.id)
      )
        issues.push(
          `${row.id} uses proof mode review, but this run has no code review to check it. Prove it with state, visual or mixed.`,
        );
    }
  }
  if (
    terminalCommand === 'complete' &&
    owningFlow !== 'pr-complete' &&
    terminalContract?.claimReviewGate === true &&
    ledger?.schemaVersion === 2
  ) {
    const { pendingClaimReviewIssues } = await import('./claim-review-gate.mjs');
    const integrityIssues = await pendingClaimReviewIssues(taskDir, ledger);
    issues.push(...integrityIssues);
    deferClaimVerdicts = integrityIssues.length === 0;
  }
  for (const issue of acceptanceContractIssues(taskDir, {
    allowWeak: terminalContract?.acceptance?.allowWeak === true,
    requireFresh: terminalContract?.acceptance?.requireFresh === true,
    deferClaimVerdicts,
  })) {
    issues.push(issue);
  }
}

if (flags.has('--require-learnings')) {
  const learnings = readText('artifacts/learnings.md');
  if (!learnings?.trim()) {
    issues.push('artifacts/learnings.md: required non-empty learnings artifact');
  }
}

if (contractPath && terminalCommand && !existsSync(contractPath)) {
  issues.push(`${contractPath}: explicit worker terminal contract missing`);
} else if (terminalContract && terminalCommand) {
  const contract = isReviewTerminal ? { ...terminalContract, whenPresent: [] } : terminalContract;
  const expanded = expandedArtifactsForCommand(contract, terminalCommand, fileExists);
  for (const artifactPath of expanded.artifacts) {
    if (flags.has('--skip-learnings') && artifactPath === 'artifacts/learnings.md') continue;
    if (artifactPath.endsWith('.md') && !readText(artifactPath)?.trim()) {
      issues.push(`${artifactPath}: required non-empty artifact (worker terminal contract)`);
    }
    if (!fileExists(artifactPath)) {
      issues.push(`${artifactPath}: required artifact missing (worker terminal contract)`);
    }
  }
  if (expanded.requireRecipeQuality && hasRecipe && !fileExists('artifacts/recipe-quality.json')) {
    issues.push('recipe.json exists but artifacts/recipe-quality.json is missing');
  }
  if (expanded.requireRecipeCoverage && hasRecipe && !fileExists('artifacts/recipe-coverage.md')) {
    issues.push('recipe.json exists but artifacts/recipe-coverage.md is missing');
  }
}

const deterministicResults = [];
if (terminalCommand !== 'blocked') {
  const checklists = new Set(
    (terminalContract?.deterministicChecks ?? []).map((step) => step.checklist),
  );
  if (checklists.size === 0) checklists.add(undefined);
  for (const checklist of checklists) {
    try {
      const result = deterministicChecks.evaluate(taskDir, checklist);
      issues.push(...result.issues);
      deterministicResults.push(...result.checks);
    } catch (error) {
      issues.push(`Deterministic checks cannot be validated: ${error.message}`);
    }
  }
}

if (issues.length > 0) {
  console.error('TASK_ARTIFACT_CONTRACT_FAIL');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}
console.log('TASK_ARTIFACT_CONTRACT_PASS');
if (deterministicResults.length > 0) {
  console.log(`${deterministicChecks.outputPrefix}${JSON.stringify(deterministicResults)}`);
}
