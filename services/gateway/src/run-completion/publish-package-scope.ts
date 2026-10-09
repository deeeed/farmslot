// run-completion/publish-package-scope.ts — decide which worker artifacts the
// publish package mirrors, and refuse an oversized mirror before copying.
//
// A worker's artifacts/ can hold far more than evidence (a 24 GB /goal
// workspace of copied repos and installs, TAT-4045). The package collects
// only what the gate and PR read:
//   - files named by evidence-manifest.json (copied by the manifest step);
//   - the step directories Farmslot writes or replays (PUBLISH_PACKAGE_STEP_DIRS);
//   - top-level text files, by extension, up to 1 MB each, and
//     top-level media of any size: with no manifest, publication auto-detects
//     evidence from the uploaded top-level media.
// Anything else under a subdirectory is never walked.

import path from 'node:path';

import {
  ARTIFACT_COPY_EXCLUDED_DIR_NAMES,
  isGatewayOwnedArtifactMirrorEntry,
  WORKER_ARTIFACT_COPY_EXCLUDES,
  WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES,
} from '../core/artifact-copy-policy.js';
import type { SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

/** Subdirectories of artifacts/ Farmslot writes or reads back, kept whole. */
export const PUBLISH_PACKAGE_STEP_DIRS = [
  // Worker recipe library; pushRunRecipeToSlot replays from the mirror's copy.
  'recipe-library',
  // Eval harness hook logs and verify output (eval-harness-lifecycle.ts).
  'recipe-harness',
] as const;
export const PUBLISH_PACKAGE_MAX_BYTES = 1024 ** 3;
export const PUBLISH_PACKAGE_MAX_FILES = 20_000;
export const PUBLISH_PACKAGE_TOP_LEVEL_TEXT_MAX_BYTES = 1024 ** 2;

const TOP_LEVEL_TEXT_EXT =
  /\.(md|markdown|txt|text|json|jsonl|ndjson|log|ya?ml|toml|csv|tsv|html?|xml|mmd|diff|patch)$/i;
const TOP_LEVEL_MEDIA_EXT = /\.(png|jpe?g|gif|mp4|mov|webm)$/i;
const TOP_LEVEL_EXCLUDES = new Set<string>(WORKER_ARTIFACT_COPY_EXCLUDES);

export interface PublishPackageEntry {
  /** Path relative to artifacts/, POSIX separators. */
  path: string;
  bytes: number;
}

/**
 * One shell command, run on the worker, listing `<bytes> ./<path>` for every
 * top-level file plus every file under the step directories and the
 * manifest-named paths. node_modules, .git and the relative copy excludes are
 * pruned, so their trees are never walked. `wc -c` reads the size from stat
 * for regular files on both BSD and GNU, and `find -type f` skips symlinks.
 */
export function buildPublishPackageScanCommand(
  workerArtifactsDir: string,
  manifestPaths: readonly string[],
): string {
  const roots = [...PUBLISH_PACKAGE_STEP_DIRS, ...manifestPaths].map((p) => shellQuote(`./${p}`));
  const prunes = [
    ...ARTIFACT_COPY_EXCLUDED_DIR_NAMES.map((name) => `-name ${shellQuote(name)}`),
    ...WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES.map((p) => `-path ${shellQuote(`./${p}`)}`),
  ].join(' -o ');
  return [
    `cd ${shellQuote(workerArtifactsDir)} || exit 3`,
    'find . -mindepth 1 -maxdepth 1 -type f -exec wc -c {} +',
    'set --',
    `for p in ${roots.join(' ')}; do [ -e "$p" ] && set -- "$@" "$p"; done`,
    `[ "$#" -eq 0 ] || find "$@" \\( ${prunes} \\) -prune -o -type f -exec wc -c {} +`,
  ].join('\n');
}

export function parsePublishPackageScan(stdout: string): PublishPackageEntry[] {
  const entries = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+\.\/(.+)$/.exec(line);
    // `wc` ends a multi-file batch with a `total` line; listed paths all start with ./
    if (match) entries.set(match[2], Number(match[1]));
  }
  return [...entries].map(([entryPath, bytes]) => ({ path: entryPath, bytes }));
}

/** The scanned entries that belong in the package: manifest-named files, step directories, eligible top-level files. */
export function selectPublishPackageEntries(
  scanned: readonly PublishPackageEntry[],
  manifestPaths: readonly string[],
): PublishPackageEntry[] {
  const named = new Set(manifestPaths);
  return scanned.filter((entry) => {
    if (named.has(entry.path) || entry.path.includes('/')) return true;
    if (TOP_LEVEL_EXCLUDES.has(entry.path) || isGatewayOwnedArtifactMirrorEntry(entry.path)) {
      return false;
    }
    if (TOP_LEVEL_MEDIA_EXT.test(entry.path)) return true;
    return (
      TOP_LEVEL_TEXT_EXT.test(entry.path) && entry.bytes <= PUBLISH_PACKAGE_TOP_LEVEL_TEXT_MAX_BYTES
    );
  });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Throw when the package would exceed PUBLISH_PACKAGE_MAX_BYTES or
 * PUBLISH_PACKAGE_MAX_FILES, naming the five largest directories (grouped two
 * levels under artifacts/) so the operator can see what to move out.
 */
export function assertPublishPackageWithinCaps(
  entries: readonly PublishPackageEntry[],
  workerArtifactsDir: string,
  caps: { maxBytes: number; maxFiles: number } = {
    maxBytes: PUBLISH_PACKAGE_MAX_BYTES,
    maxFiles: PUBLISH_PACKAGE_MAX_FILES,
  },
): void {
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes <= caps.maxBytes && entries.length <= caps.maxFiles) return;
  const dirs = new Map<string, { bytes: number; files: number }>();
  for (const entry of entries) {
    const dir = path.posix.dirname(entry.path).split('/').slice(0, 2).join('/');
    const key = dir === '.' ? 'artifacts/ (top-level files)' : `artifacts/${dir}/`;
    const totals = dirs.get(key) ?? { bytes: 0, files: 0 };
    totals.bytes += entry.bytes;
    totals.files += 1;
    dirs.set(key, totals);
  }
  const largest = [...dirs]
    .sort((a, b) => b[1].bytes - a[1].bytes || b[1].files - a[1].files)
    .slice(0, 5)
    .map(([dir, totals]) => `${dir} ${formatBytes(totals.bytes)} in ${totals.files} file(s)`);
  throw new Error(
    `publish package would mirror ${entries.length} file(s), ${formatBytes(totalBytes)} from ${workerArtifactsDir}, ` +
      `over the cap of ${caps.maxFiles} files / ${formatBytes(caps.maxBytes)}. ` +
      `Largest directories: ${largest.join('; ')}. ` +
      'Keep clones, installs and scratch workspaces out of artifacts/.',
  );
}

/** Run the scan on the worker (one exec, local or remote) and parse its listing. */
export async function scanPublishPackage(
  vars: SlotVars,
  workerArtifactsDir: string,
  manifestPaths: readonly string[],
): Promise<PublishPackageEntry[]> {
  const result = await execOnSlot(
    vars,
    buildPublishPackageScanCommand(workerArtifactsDir, manifestPaths),
    { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `publish package scan failed in ${workerArtifactsDir} (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`,
    );
  }
  return parsePublishPackageScan(result.stdout);
}
