/**
 * Learning Package Format markers. One integer governs both the spec version
 * and the on-disk schemaVersion stamp.
 */
export const SPEC_VERSION = 1 as const;
export const SCHEMA_VERSION = 1 as const;

/**
 * Version of the crypto-secret floor deny-set applied by the scrubber. Increment
 * when the floor grows so packages record which floor screened them.
 * v2: cookie headers/jars (multi-pair + structured objects), OAuth
 * bearer/access/refresh tokens, session tokens, JSON-escape passes,
 * metadata/caller-string gating.
 */
export const SCRUB_FLOOR_VERSION = 2 as const;

/**
 * The eight files every valid package MUST contain (spec section 2). Paths are
 * package-relative.
 */
export const REQUIRED_FILES: readonly string[] = [
  'manifest.json',
  'task.md',
  'source.json',
  'report.md',
  'learnings.md',
  'artifacts/index.json',
  'scrub-report.json',
  'provenance.json',
];

/**
 * run-slug grammar (spec section 1): `<utc-start>-<surface>-<flow>[-<ticket>]-<8hex>`.
 * The optional ticket segment sits between flow and the always-present 8-hex
 * disambiguator. Also the `packageId` pattern in the manifest schema.
 */
export const RUN_SLUG_PATTERN =
  /^[0-9]{8}T[0-9]{6}Z-[a-z][a-z0-9]*-[a-z0-9]+-(?:[a-z][a-z0-9-]*-)?[a-f0-9]{8}$/;
