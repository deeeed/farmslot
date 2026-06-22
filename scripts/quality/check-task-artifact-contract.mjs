#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const taskDir = process.argv[2];
const flags = new Set(process.argv.slice(3));

if (!taskDir) {
  console.error('usage: check-task-artifact-contract.mjs <task-dir> [--require-recipe-quality-if-recipe] [--require-recipe-coverage-if-recipe]');
  process.exit(2);
}

const artifactsDir = path.join(taskDir, 'artifacts');
const issues = [];
const mediaExt = /\.(png|jpe?g|gif|mp4|mov|webm)$/i;
const internalArtifactPath = /^artifacts\/(?:runtime-launch|runner-blockers)\//;
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
  const withoutArtifacts = segments[0] === 'artifacts' ? segments.slice(1).join('/') : segments.join('/');
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
  if (artifact.version !== 1) issues.push('recipe-quality.json: version must be 1');
  if (!['pass', 'warn', 'fail'].includes(artifact.verdict)) {
    issues.push('recipe-quality.json: verdict must be pass, warn, or fail');
  }
  if (!isRecord(artifact.compact) || !['PASS', 'WARN', 'FAIL'].includes(artifact.compact.verdict)) {
    issues.push('recipe-quality.json: compact.verdict must be PASS, WARN, or FAIL');
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
  if (manifest.preferred_mode !== undefined && !['screenshots', 'video'].includes(manifest.preferred_mode)) {
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
        if (typeof entry.label !== 'string' || !entry.label.trim()) issues.push(`${prefix}.label: expected non-empty string`);
        optionalStringArray(entry, 'covers', prefix);
        optionalString(entry, 'before', prefix);
        optionalString(entry, 'after', prefix);
        optionalString(entry, 'note', prefix);
        if (entry.before === undefined && entry.after === undefined) issues.push(`${prefix}: expected before or after`);
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
        if (typeof entry.label !== 'string' || !entry.label.trim()) issues.push(`${prefix}.label: expected non-empty string`);
        optionalStringArray(entry, 'covers', prefix);
        if (typeof entry.file !== 'string' || !entry.file.trim()) issues.push(`${prefix}.file: expected non-empty string`);
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
      if (manifest.videos.preferred !== undefined && typeof manifest.videos.preferred !== 'boolean') {
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
        if (typeof entry.file !== 'string' || !entry.file.trim()) issues.push(`${prefix}.file: expected non-empty string`);
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
if (hasRecipe && flags.has('--require-recipe-quality-if-recipe') && !fileExists('artifacts/recipe-quality.json')) {
  issues.push('recipe.json exists but artifacts/recipe-quality.json is missing');
}
if (hasRecipe && flags.has('--require-recipe-coverage-if-recipe') && !fileExists('artifacts/recipe-coverage.md')) {
  issues.push('recipe.json exists but artifacts/recipe-coverage.md is missing');
}
validateRecipeQualityArtifact();

const parsed = parseManifest();
const coverage = readText('artifacts/recipe-coverage.md');
if (coverage && /\|\s*(visual|mixed)\s*\|/i.test(coverage)) {
  const refCount = parsed?.refs?.size ?? 0;
  if (refCount === 0) issues.push('recipe-coverage.md declares visual/mixed proof but evidence-manifest has no media references');
}

if (issues.length > 0) {
  console.error('TASK_ARTIFACT_CONTRACT_FAIL');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}
console.log('TASK_ARTIFACT_CONTRACT_PASS');
