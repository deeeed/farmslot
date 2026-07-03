import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { loadSchema, type SchemaName } from '../spec/schemas.js';
import type {
  ArtifactsIndex,
  Manifest,
  ScrubReport,
  VisualPassAttestation,
} from '../spec/types.js';
import { REQUIRED_FILES } from '../spec/version.js';

import { validateAgainstSchema } from './json-schema.js';
import { isValidRunSlug } from './run-slug.js';

/** Result of validating a package directory against the format spec (section 8). */
export interface ValidateResult {
  valid: boolean;
  errors: string[];
}

interface LoadedJson<T> {
  value: T | undefined;
  parseError?: string;
}

function loadJson<T>(file: string): LoadedJson<T> {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) as T };
  } catch (error) {
    return { value: undefined, parseError: (error as Error).message };
  }
}

function validateJsonFile(
  dir: string,
  relativePath: string,
  schemaName: SchemaName,
  errors: string[],
): unknown {
  const abs = path.join(dir, relativePath);
  const loaded = loadJson<unknown>(abs);
  if (loaded.value === undefined) {
    errors.push(`${relativePath}: invalid JSON (${loaded.parseError})`);
    return undefined;
  }
  for (const error of validateAgainstSchema(loaded.value, loadSchema(schemaName))) {
    errors.push(`${relativePath}${error.path}: ${error.message}`);
  }
  return loaded.value;
}

function checkNonEmptyMarkdown(dir: string, relativePath: string, errors: string[]): void {
  const abs = path.join(dir, relativePath);
  const content = readFileSync(abs, 'utf8');
  if (content.trim() === '') {
    errors.push(`${relativePath}: must not be empty`);
  }
}

/**
 * Reference validator for the Learning Package Format v1 (spec section 8). Checks
 * the required file set, per-file schema conformance (including the if/then
 * co-constraints), the run-slug grammar, and the cross-file safety invariants
 * (scrub status pass, media artifacts carry a visual-pass attestation).
 */
export function validateLearningPackage(dir: string): ValidateResult {
  const errors: string[] = [];

  if (!existsSync(dir)) {
    return { valid: false, errors: [`package directory does not exist: ${dir}`] };
  }

  for (const required of REQUIRED_FILES) {
    if (!existsSync(path.join(dir, required))) {
      errors.push(`missing required file: ${required}`);
    }
  }

  const manifest = existsSync(path.join(dir, 'manifest.json'))
    ? (validateJsonFile(dir, 'manifest.json', 'manifest', errors) as Manifest | undefined)
    : undefined;
  if (existsSync(path.join(dir, 'source.json'))) {
    validateJsonFile(dir, 'source.json', 'source', errors);
  }
  if (existsSync(path.join(dir, 'provenance.json'))) {
    validateJsonFile(dir, 'provenance.json', 'provenance', errors);
  }
  const artifactsIndex = existsSync(path.join(dir, 'artifacts/index.json'))
    ? (validateJsonFile(dir, 'artifacts/index.json', 'artifacts-index', errors) as
        | ArtifactsIndex
        | undefined)
    : undefined;
  const scrubReport = existsSync(path.join(dir, 'scrub-report.json'))
    ? (validateJsonFile(dir, 'scrub-report.json', 'scrub-report', errors) as
        | ScrubReport
        | undefined)
    : undefined;

  for (const md of ['task.md', 'report.md', 'learnings.md']) {
    if (existsSync(path.join(dir, md))) checkNonEmptyMarkdown(dir, md, errors);
  }

  if (existsSync(path.join(dir, 'pr/publication.json'))) {
    validateJsonFile(dir, 'pr/publication.json', 'pr-publication', errors);
  }

  if (manifest?.packageId !== undefined && !isValidRunSlug(manifest.packageId)) {
    errors.push(`manifest.json/packageId: '${manifest.packageId}' violates the run-slug grammar`);
  }

  // A valid written package is scrubbed pass, and the manifest agrees with the report.
  if (scrubReport?.status !== undefined && scrubReport.status !== 'pass') {
    errors.push(
      `scrub-report.json/status: must be 'pass' for a valid package (was '${scrubReport.status}')`,
    );
  }
  if (
    manifest?.scrubbing?.status !== undefined &&
    scrubReport?.status !== undefined &&
    manifest.scrubbing.status !== scrubReport.status
  ) {
    errors.push('manifest.json/scrubbing/status: must match scrub-report.json/status');
  }

  // Every included media artifact needs a visual-pass attestation (section 3.6).
  if (artifactsIndex?.artifacts && scrubReport) {
    const attested = new Set(
      (scrubReport.visualPassAttestations ?? []).map((a: VisualPassAttestation) => a.file),
    );
    for (const artifact of artifactsIndex.artifacts) {
      if (
        (artifact.kind === 'screenshot' || artifact.kind === 'video') &&
        !attested.has(artifact.path)
      ) {
        errors.push(
          `artifacts/index.json: media artifact '${artifact.path}' has no visualPassAttestation in scrub-report.json`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
