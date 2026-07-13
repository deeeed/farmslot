import { createHash } from 'node:crypto';
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
  // The validator is total: an unreadable-but-existing file is a collected
  // error, never a thrown one.
  let content: string;
  try {
    content = readFileSync(abs, 'utf8');
  } catch (error) {
    errors.push(`${relativePath}: unreadable (${(error as Error).message})`);
    return;
  }
  if (content.trim() === '') {
    errors.push(`${relativePath}: must not be empty`);
  }
}

/**
 * Traversal-safety reason for an untrusted package-relative path from a JSON
 * file (manifest.files keys, artifacts/index.json paths). The validator itself
 * must never read outside the package dir it was pointed at.
 */
function unsafeRelPathReason(rel: string): string | undefined {
  if (rel === '' || rel.includes('\\')) return 'empty or contains a backslash';
  if (path.isAbsolute(rel)) return 'absolute path';
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return `unsafe segment '${segment}'`;
    }
  }
  return undefined;
}

/** Containment-checked join for validator reads; undefined when out of bounds. */
function containedPath(dir: string, rel: string): string | undefined {
  const resolved = path.resolve(path.join(dir, rel));
  const root = path.resolve(dir);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : undefined;
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

  if (existsSync(path.join(dir, 'grade.json'))) {
    validateJsonFile(dir, 'grade.json', 'grade', errors);
  }

  if (manifest?.packageId !== undefined && !isValidRunSlug(manifest.packageId)) {
    errors.push(`manifest.json/packageId: '${manifest.packageId}' violates the run-slug grammar`);
  }

  // Integrity: every file the manifest inventories must exist with the recorded
  // post-scrub hash. (Unknown EXTRA files stay tolerated here per the
  // forward-compat consumer rule; the write path separately refuses
  // uninventoried files before sharing.) Inventory keys are untrusted JSON:
  // traversal-shaped keys are collected errors and are NEVER read - the
  // validator itself must not touch anything outside the package dir.
  const verifiedHashes = new Map<string, string>();
  for (const [rel, record] of Object.entries(manifest?.files ?? {})) {
    const unsafe = unsafeRelPathReason(rel);
    const abs = unsafe === undefined ? containedPath(dir, rel) : undefined;
    if (unsafe !== undefined || abs === undefined) {
      errors.push(
        `manifest.json/files/${rel}: unsafe inventory key (${unsafe ?? 'escapes the package dir'})`,
      );
      continue;
    }
    if (!existsSync(abs)) {
      errors.push(`manifest.json/files/${rel}: listed in the inventory but missing on disk`);
      continue;
    }
    let sha256: string;
    try {
      sha256 = createHash('sha256').update(readFileSync(abs)).digest('hex');
    } catch (error) {
      errors.push(
        `manifest.json/files/${rel}: not a readable regular file (${(error as Error).message})`,
      );
      continue;
    }
    verifiedHashes.set(rel, sha256);
    if (record.sha256 !== sha256) {
      errors.push(
        `manifest.json/files/${rel}: sha256 mismatch - file changed after assembly ` +
          `(expected ${record.sha256}, found ${sha256})`,
      );
    }
  }

  // artifacts/index.json records must correspond to real, inventoried files:
  // safe path, present in manifest.files, and hash-consistent - fabricated
  // artifact records must not validate.
  if (artifactsIndex?.artifacts && manifest?.files) {
    for (const artifact of artifactsIndex.artifacts) {
      const unsafe = unsafeRelPathReason(artifact.path);
      if (unsafe !== undefined) {
        errors.push(`artifacts/index.json: artifact path '${artifact.path}' is unsafe (${unsafe})`);
        continue;
      }
      const record = manifest.files[artifact.path];
      if (record === undefined) {
        errors.push(
          `artifacts/index.json: artifact '${artifact.path}' is not in the manifest.files inventory`,
        );
        continue;
      }
      if (artifact.sha256 !== record.sha256) {
        errors.push(
          `artifacts/index.json: artifact '${artifact.path}' sha256 disagrees with manifest.files`,
        );
      }
      const onDisk = verifiedHashes.get(artifact.path);
      if (onDisk !== undefined && artifact.sha256 !== onDisk) {
        errors.push(
          `artifacts/index.json: artifact '${artifact.path}' sha256 disagrees with the file on disk`,
        );
      }
    }
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
