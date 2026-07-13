import path from 'node:path';

/**
 * One path segment as used in package paths, index filenames, and staging dir
 * ids. Manifest fields are schema-unconstrained strings, so every segment that
 * reaches filesystem IO is validated here: no separators, no traversal, no
 * hidden/empty names. Code-level guard today; the SPEC schemas may later add
 * matching patterns.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Reject a value that cannot be used as a single, safe path segment. */
export function assertSafePathSegment(value: string, field: string): string {
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    !SAFE_SEGMENT.test(value)
  ) {
    throw new Error(
      `unsafe path segment for ${field}: ${JSON.stringify(value)}. Segments must match ` +
        `${SAFE_SEGMENT} (no separators, no '..', no leading dot). Next: fix the field in ` +
        'the run metadata/manifest - path-shaped values are never valid keys.',
    );
  }
  return value;
}

/**
 * Assert `candidate` resolves inside `root`. Belt-and-braces behind the segment
 * guard: no computed destination may escape the staging root or the destination
 * repo, whatever the inputs were.
 */
export function assertContained(root: string, candidate: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(
      `${label} escapes its root: ${candidate} is outside ${root}. Next: this indicates a ` +
        'path-shaped field in the inputs; fix the producing metadata.',
    );
  }
  return resolved;
}
