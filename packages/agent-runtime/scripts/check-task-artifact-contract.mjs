#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { expandedArtifactsForCommand } = require('./worker-terminal-contract.cjs');

let sharedRecipeQualityValidator = null;
let sharedRecipeDocumentValidator = null;
// Mirror @farmslot/protocol recipeProtocolSchemaUrlForVersion: only v1 is a
// supported schema_version, so do not synthesize URLs for other versions.
let sharedRecipeSchemaUrlForVersion = (version) =>
  version === 1 ? 'https://farmslot.io/schemas/recipe-v1.schema.json' : null;
try {
  ({ isRecipeQualityArtifact: sharedRecipeQualityValidator } =
    await import('@farmslot/protocol/contracts/recipes'));
} catch (error) {
  // Source checkouts run this script before @farmslot/protocol has emitted dist/.
  // Keep strict local validation instead of downgrading to the historical loose gate.
  if (process.env.FARMSLOT_DEBUG_AGENT_RUNTIME) {
    console.warn(`[agent-runtime] using local RecipeQualityArtifact fallback: ${error.message}`);
  }
}
try {
  const recipeProtocol = await import('@farmslot/protocol/recipe');
  sharedRecipeDocumentValidator = recipeProtocol.validateRecipeDocument;
  if (typeof recipeProtocol.recipeProtocolSchemaUrlForVersion === 'function') {
    sharedRecipeSchemaUrlForVersion = recipeProtocol.recipeProtocolSchemaUrlForVersion;
  }
} catch (error) {
  // Compatibility fail-safe: source checkouts can run before @farmslot/protocol
  // has emitted dist/. In that degraded state, do not bypass recipe checks;
  // enforce the minimum executable envelope locally until the shared validator loads.
  if (process.env.FARMSLOT_DEBUG_AGENT_RUNTIME) {
    console.warn(`[agent-runtime] using local Recipe v1 fallback: ${error.message}`);
  }
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
    return statSync(path.join(taskDir, rel)).isFile();
  } catch {
    return false;
  }
}

function readText(rel) {
  const p = path.join(taskDir, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
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
    !['fix-bug', 'review-pr', 'dev', 'pr-complete', 'merge-main'].includes(fields.flow_type)
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
  const text = readText('artifacts/recipe-quality.json');
  if (!text) return;
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
  // The composition must be proven: recipe.json's call.refs are proven either by
  // resolved-recipe.json (the self-contained composition, validated in full) — in
  // which case recipe.json is checked envelope-only — or by recipe.json being
  // self-contained itself, in which case it is validated in full.
  const hasResolvedRecipe = fileExists('artifacts/resolved-recipe.json');
  validateRecipeDocumentArtifactAt('artifacts/recipe.json', 'recipe.json', {
    skipFlowCallResolution: hasResolvedRecipe,
  });
  validateRecipeDocumentArtifactAt('artifacts/resolved-recipe.json', 'resolved-recipe.json', {});
}

function validateRecipeDocumentArtifactAt(relPath, label, options) {
  const text = readText(relPath);
  if (!text) return;
  let recipe;
  try {
    recipe = JSON.parse(text);
  } catch (error) {
    issues.push(`${label}: invalid JSON: ${error.message}`);
    return;
  }
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
  if (recipe.schema_version !== 1) {
    issues.push(`${label}: schema_version must equal 1`);
  }
  const expectedSchemaUrl = sharedRecipeSchemaUrlForVersion(recipe.schema_version);
  if (recipe.$schema != null && recipe.$schema !== expectedSchemaUrl) {
    issues.push(
      `${label}: $schema must match schema_version (${expectedSchemaUrl ?? 'unknown schema_version'})`,
    );
  }
  if (!isRecord(recipe.validate) || !isRecord(recipe.validate.workflow)) {
    issues.push(`${label}: validate.workflow is required`);
    return;
  }
  const workflow = recipe.validate.workflow;
  if (typeof workflow.entry !== 'string' || !workflow.entry.trim()) {
    issues.push(`${label}: validate.workflow.entry must be a non-empty string`);
  }
  if (!isRecord(workflow.nodes) || Object.keys(workflow.nodes).length === 0) {
    issues.push(`${label}: validate.workflow.nodes must be a non-empty object`);
  }
}

function parseManifest() {
  const text = readText('artifacts/evidence-manifest.json');
  if (!text) return null;
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

const hasRecipe = fileExists('artifacts/recipe.json');
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

if (flags.has('--require-learnings')) {
  const learnings = readText('artifacts/learnings.md');
  if (!learnings?.trim()) {
    issues.push('artifacts/learnings.md: required non-empty learnings artifact');
  }
}

if (contractPath && existsSync(contractPath) && terminalCommand) {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
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
