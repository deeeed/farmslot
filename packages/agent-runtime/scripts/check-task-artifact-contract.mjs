#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { expandedArtifactsForCommand } = require('./worker-terminal-contract.cjs');
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
    'usage: check-task-artifact-contract.mjs <task-dir> [--contract path] [--terminal complete|no-change|blocked] [--require-recipe-quality-if-recipe] [--require-recipe-coverage-if-recipe] [--require-learnings] [--skip-learnings]',
  );
  process.exit(2);
}

const issues = [];
const mediaExt = /\.(png|jpe?g|gif|mp4|mov|webm)$/i;
const internalArtifactPath =
  /^artifacts\/(?:harness-launch|harness-relaunch|harness-relaunch-node20|runtime-launch|runtime-relaunch|runner-blockers)\//;
const allowedManifestKeys = new Set([
  'version',
  'preferred_mode',
  'summary',
  'before_after_pairs',
  'standalone',
  'omit',
  'videos',
  'before_state_capture',
]);
const allowedPairKeys = new Set(['label', 'covers', 'before', 'after', 'note']);
const allowedStandaloneKeys = new Set(['label', 'covers', 'file', 'note']);
const allowedVideoKeys = new Set(['before', 'after', 'preferred', 'note']);
const allowedOmitKeys = new Set(['file', 'reason']);

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
  const candidate = realpathSync(path.resolve(taskDir, rel));
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${rel} resolves outside the task directory`);
  }
  return candidate;
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

function unknownKeys(record, allowed, prefix) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push(`${prefix}.${key}: unknown key`);
  }
}

function optionalString(record, key, prefix) {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    issues.push(`${prefix}.${key}: expected string`);
  }
}

function optionalStringArray(record, key, prefix) {
  if (record[key] === undefined) return;
  if (!Array.isArray(record[key]) || record[key].some((entry) => typeof entry !== 'string')) {
    issues.push(`${prefix}.${key}: expected string[]`);
  }
}

function normalizeArtifactPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmed)) return null;
  const pathPart = trimmed.split(/[?#]/, 1)[0];
  const normalized = pathPart.replace(/\\/g, '/').replace(/^\.\/+/g, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.includes('\0')) return null;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const withoutArtifacts =
    segments[0] === 'artifacts' ? segments.slice(1).join('/') : segments.join('/');
  if (!withoutArtifacts || !mediaExt.test(withoutArtifacts)) return null;
  return `artifacts/${withoutArtifacts}`;
}

function addRef(refs, value) {
  const normalized = normalizeArtifactPath(value);
  if (!normalized) return;
  if (internalArtifactPath.test(normalized)) {
    issues.push(`evidence-manifest references internal artifact: ${normalized}`);
    return;
  }
  refs.add(normalized);
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

  const packageRoot = 'artifacts/recipe-run';
  const recipe = readJsonArtifact(`${packageRoot}/recipe.json`, 'recipe-run/recipe.json');
  if (recipe === undefined) {
    issues.push('artifacts/recipe-run/recipe.json is missing');
    return;
  }
  if (canonicalJson(authoredRecipe) !== canonicalJson(recipe)) {
    issues.push('artifacts/recipe-run/recipe.json does not match artifacts/recipe.json');
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
  const relPath = 'artifacts/evidence-manifest.json';
  if (!fileExists(relPath)) return null;
  const text = readText(relPath) ?? '';
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    issues.push(`evidence-manifest.json: invalid JSON: ${error.message}`);
    return null;
  }
  if (!isRecord(manifest)) {
    issues.push('evidence-manifest.json: expected object');
    return null;
  }
  unknownKeys(manifest, allowedManifestKeys, 'manifest');
  if (manifest.version !== undefined && typeof manifest.version !== 'number') {
    issues.push('manifest.version: expected number');
  }
  if (
    manifest.preferred_mode !== undefined &&
    !['screenshots', 'video'].includes(manifest.preferred_mode)
  ) {
    issues.push('manifest.preferred_mode: expected screenshots or video');
  }
  optionalString(manifest, 'summary', 'manifest');

  if (manifest.before_after_pairs !== undefined) {
    if (!Array.isArray(manifest.before_after_pairs)) {
      issues.push('manifest.before_after_pairs: expected array');
    } else {
      manifest.before_after_pairs.forEach((entry, index) => {
        const prefix = `manifest.before_after_pairs[${index}]`;
        if (!isRecord(entry)) return issues.push(`${prefix}: expected object`);
        unknownKeys(entry, allowedPairKeys, prefix);
        if (typeof entry.label !== 'string' || !entry.label.trim())
          issues.push(`${prefix}.label: expected non-empty string`);
        optionalStringArray(entry, 'covers', prefix);
        optionalString(entry, 'before', prefix);
        optionalString(entry, 'after', prefix);
        optionalString(entry, 'note', prefix);
        if (entry.before === undefined && entry.after === undefined)
          issues.push(`${prefix}: expected before or after`);
      });
    }
  }

  if (manifest.standalone !== undefined) {
    if (!Array.isArray(manifest.standalone)) {
      issues.push('manifest.standalone: expected array');
    } else {
      manifest.standalone.forEach((entry, index) => {
        const prefix = `manifest.standalone[${index}]`;
        if (!isRecord(entry)) return issues.push(`${prefix}: expected object`);
        unknownKeys(entry, allowedStandaloneKeys, prefix);
        if (typeof entry.label !== 'string' || !entry.label.trim())
          issues.push(`${prefix}.label: expected non-empty string`);
        optionalStringArray(entry, 'covers', prefix);
        if (typeof entry.file !== 'string' || !entry.file.trim())
          issues.push(`${prefix}.file: expected non-empty string`);
        optionalString(entry, 'note', prefix);
      });
    }
  }

  if (manifest.videos !== undefined) {
    if (!isRecord(manifest.videos)) {
      issues.push('manifest.videos: expected object');
    } else {
      unknownKeys(manifest.videos, allowedVideoKeys, 'manifest.videos');
      optionalString(manifest.videos, 'before', 'manifest.videos');
      optionalString(manifest.videos, 'after', 'manifest.videos');
      optionalString(manifest.videos, 'note', 'manifest.videos');
      if (
        manifest.videos.preferred !== undefined &&
        typeof manifest.videos.preferred !== 'boolean'
      ) {
        issues.push('manifest.videos.preferred: expected boolean');
      }
    }
  }

  if (manifest.omit !== undefined) {
    if (!Array.isArray(manifest.omit)) {
      issues.push('manifest.omit: expected array');
    } else {
      manifest.omit.forEach((entry, index) => {
        const prefix = `manifest.omit[${index}]`;
        if (typeof entry === 'string') return;
        if (!isRecord(entry)) return issues.push(`${prefix}: expected string or object`);
        unknownKeys(entry, allowedOmitKeys, prefix);
        if (typeof entry.file !== 'string' || !entry.file.trim())
          issues.push(`${prefix}.file: expected non-empty string`);
        optionalString(entry, 'reason', prefix);
      });
    }
  }

  const refs = new Set();
  for (const pair of manifest.before_after_pairs ?? []) {
    addRef(refs, pair?.before);
    addRef(refs, pair?.after);
  }
  for (const entry of manifest.standalone ?? []) addRef(refs, entry?.file);
  addRef(refs, manifest.videos?.before);
  addRef(refs, manifest.videos?.after);

  for (const ref of [...refs].sort()) {
    if (!fileExists(ref)) issues.push(`evidence-manifest references missing artifact: ${ref}`);
  }
  return { manifest, refs };
}

let terminalContract;
if (contractPath && terminalCommand && existsSync(contractPath)) {
  try {
    terminalContract = JSON.parse(readFileSync(contractPath, 'utf8'));
  } catch (error) {
    issues.push(`${contractPath}: invalid worker terminal contract JSON (${error.message})`);
  }
}
const isSelfReviewTerminal = terminalContract?.flowType === 'self-review';
const hasRecipe = fileExists('artifacts/recipe.json');

// A reviewer must be able to report ISSUES when worker-owned proof is invalid.
// Its terminal gate validates only the reviewer-owned feedback artifact below;
// contribution and fix flows still validate the complete proof package.
if (!isSelfReviewTerminal) {
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

if (flags.has('--require-learnings')) {
  const learnings = readText('artifacts/learnings.md');
  if (!learnings?.trim()) {
    issues.push('artifacts/learnings.md: required non-empty learnings artifact');
  }
}

if (contractPath && terminalCommand && !existsSync(contractPath)) {
  issues.push(`${contractPath}: explicit worker terminal contract missing`);
} else if (terminalContract && terminalCommand) {
  const contract = isSelfReviewTerminal
    ? { ...terminalContract, whenPresent: [] }
    : terminalContract;
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

if (issues.length > 0) {
  console.error('TASK_ARTIFACT_CONTRACT_FAIL');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}
console.log('TASK_ARTIFACT_CONTRACT_PASS');
