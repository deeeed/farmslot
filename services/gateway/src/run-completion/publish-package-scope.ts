// run-completion/publish-package-scope.ts — decide which worker artifacts the
// publish package mirrors, and refuse an oversized mirror before copying.
//
// A worker's artifacts/ can hold far more than evidence (a 24 GB /goal
// workspace of copied repos and installs, TAT-4045). The package collects
// only what the gate and PR read:
//   - media named by evidence-manifest.json (copied by the manifest step) or
//     cited by the worker's pr-body.md / pr-description.md;
//   - recipe output packages, i.e. each directory up to
//     PUBLISH_PACKAGE_MAX_DEPTH levels under artifacts/ holding a
//     recipe-runner package root marker (artifact-manifest.json, or
//     summary.json beside trace.json), kept whole since its recording,
//     timeline and trace are read together;
//   - the step directories Farmslot templates write or Farmslot reads back
//     (PUBLISH_PACKAGE_STEP_DIRS), packages or not;
//   - top-level text and media files, by extension, at any size. Reports and
//     proof files (report.html, trace.json, recordings) have readers whatever
//     their size, so the overall caps bound them instead of a per-file one.
// Anything else under a subdirectory is walked only to find package markers,
// no deeper than PUBLISH_PACKAGE_MAX_DEPTH + 1. The promoted
// recipe-runs/<id> snapshot, copied separately, is measured in the same scan
// so the caps cover the whole mirror.

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

import { normalizeEvidenceManifestArtifactPath } from './evidence-manifest.js';

/**
 * Subdirectories of artifacts/ Farmslot templates write or Farmslot reads
 * back, kept whole. Package detection does not cover them: the library,
 * harness logs, check-diff and review evidence carry no package marker, and a
 * template's recipe-run directory is still read (mm-harness `pr-body render`
 * reads recipe-run/report.md) when the run died before writing its markers.
 */
export const PUBLISH_PACKAGE_STEP_DIRS = [
  // Worker recipe library; pushRunRecipeToSlot replays from the mirror's copy.
  'recipe-library',
  // Eval harness hook logs and verify output (eval-harness-lifecycle.ts).
  'recipe-harness',
  // Recipe runs the farm worker templates write (`--artifacts-dir
  // {{TASK_DIR}}/artifacts/<dir>`); mm-harness `pr-body render` reads
  // recipe-run/report.md for the PR's Validation Logs.
  'recipe-run',
  'recipe-run-baseline',
  'recipe-run-repro',
  'recipe-rerun',
  'recipe-baseline-run',
  'review-recipe-run',
  'perps-smoke',
  // mm-harness check-diff output (core and extension templates).
  'check-diff',
  'check-diff-final',
  // Review recordings and screenshots (review-pr templates).
  'evidence',
] as const;
/** Deepest package root detected, in directory levels under artifacts/. */
export const PUBLISH_PACKAGE_MAX_DEPTH = 3;
export const PUBLISH_PACKAGE_MAX_BYTES = 1024 ** 3;
export const PUBLISH_PACKAGE_MAX_FILES = 20_000;
/**
 * The scan stops listing after this many lines, so its output stays well under
 * the exec buffer. A listing cut short is over the file cap by construction.
 */
const SCAN_LINE_LIMIT = PUBLISH_PACKAGE_MAX_FILES * 2;

const TOP_LEVEL_KEPT_EXT =
  /\.(md|markdown|txt|text|json|jsonl|ndjson|log|ya?ml|toml|csv|tsv|html?|xml|mmd|diff|patch|png|jpe?g|gif|mp4|mov|webm)$/i;
const TOP_LEVEL_EXCLUDES = new Set<string>([
  ...WORKER_ARTIFACT_COPY_EXCLUDES,
  ...WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES,
]);

export interface PublishPackageEntry {
  /** Path relative to artifacts/, POSIX separators. */
  path: string;
  bytes: number;
  /** Worker path to read instead of `path`, for a cited symlink resolved to its target. */
  sourcePath?: string;
}

export interface PublishPackageScanRoots {
  /** Files named by the evidence manifest or cited by the PR body, relative to artifacts/. */
  namedPaths: readonly string[];
  /** The promoted recipe-runs/<id> snapshot, relative to artifacts/. */
  snapshotRoot?: string | null;
}

export interface PublishPackageScan {
  /** Regular files, deduplicated by path. */
  entries: PublishPackageEntry[];
  /** Symlinks met in the scanned scope; none is followed by the scan. */
  links: string[];
  /** The listing hit SCAN_LINE_LIMIT before the scan finished. */
  truncated: boolean;
}

/**
 * One shell command, run on the worker, printing `<bytes> ./<path>` for every
 * regular file and `L ./<path>` for every symlink in scope: top-level entries,
 * the step directories, the named paths, the recipe packages found by their
 * markers, and the promoted snapshot minus its raw screenshots/. Marker
 * detection walks only PUBLISH_PACKAGE_MAX_DEPTH + 1 levels. node_modules,
 * .git and the relative copy excludes are pruned, so their trees are never
 * walked. `wc -c` reads sizes from stat for regular files on both BSD and
 * GNU. The last line, `S <status>`, carries the first failing find's exit
 * status; output is capped at SCAN_LINE_LIMIT lines.
 */
export function buildPublishPackageScanCommand(
  workerArtifactsDir: string,
  roots: PublishPackageScanRoots,
): string {
  const scopeRoots = [...PUBLISH_PACKAGE_STEP_DIRS, ...roots.namedPaths].map((p) =>
    shellQuote(`./${p}`),
  );
  const prunes = [
    ...ARTIFACT_COPY_EXCLUDED_DIR_NAMES.map((name) => `-name ${shellQuote(name)}`),
    ...WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES.map((p) => `-path ${shellQuote(`./${p}`)}`),
  ].join(' -o ');
  // Top-level trees the mirror never takes from the worker (raw screenshot
  // spool, recipe-runs history, internal launch output, gateway-owned review
  // directories) are pruned from package detection too.
  const detectionPrunes = [
    prunes,
    ...WORKER_ARTIFACT_COPY_EXCLUDES.map((name) => `-path ${shellQuote(`./${name}`)}`),
    ...['review-loop-*', 'self-review-*', 'independent-review-*'].map(
      (pattern) => `-path ${shellQuote(`./${pattern}`)}`,
    ),
  ].join(' -o ');
  const list = `\\( -type f -exec wc -c {} + \\) -o \\( -type l -exec printf 'L %s\\n' {} + \\)`;
  const keep = '|| { rc=$?; [ "$scan_status" -ne 0 ] || scan_status=$rc; }';
  const lines = [
    'scan_status=0',
    `find . -mindepth 1 -maxdepth 1 ${list} ${keep}`,
    'set --',
    `for p in ${scopeRoots.join(' ')}; do if [ -e "$p" ] || [ -L "$p" ]; then set -- "$@" "$p"; fi; done`,
    // A package root is the directory of its marker. One newline-split loop
    // reads the marker list; a failing find reports `E:<status>` through it.
    'set -f',
    'scan_ifs=$IFS',
    "IFS='\n'",
    `for m in $(find . -maxdepth ${PUBLISH_PACKAGE_MAX_DEPTH + 1} \\( ${detectionPrunes} \\) -prune -o -type f -path './*/*' \\( -name artifact-manifest.json -o -name summary.json \\) -print || echo "E:$?"); do`,
    '  case $m in',
    '    E:*) [ "$scan_status" -ne 0 ] || scan_status=${m#E:}; continue ;;',
    '    */summary.json) [ -f "${m%/*}/trace.json" ] || continue ;;',
    '  esac',
    '  set -- "$@" "${m%/*}"',
    'done',
    'IFS=$scan_ifs',
    `if [ "$#" -gt 0 ]; then find "$@" \\( ${prunes} \\) -prune -o ${list} ${keep}; fi`,
  ];
  if (roots.snapshotRoot) {
    const snapshot = `./${roots.snapshotRoot}`;
    lines.push(
      `if [ -d ${shellQuote(snapshot)} ]; then find ${shellQuote(snapshot)} -path ${shellQuote(`${snapshot}/screenshots`)} -prune -o ${list} ${keep}; fi`,
    );
  }
  lines.push('echo "S $scan_status"');
  return [
    `cd ${shellQuote(workerArtifactsDir)} || exit 3`,
    `{\n${lines.join('\n')}\n} | head -n ${SCAN_LINE_LIMIT}`,
  ].join('\n');
}

export function parsePublishPackageScan(
  stdout: string,
): PublishPackageScan & { status: number | null } {
  const entries = new Map<string, number>();
  const links = new Set<string>();
  let status: number | null = null;
  for (const line of stdout.split('\n')) {
    const file = /^\s*(\d+)\s+\.\/(.+)$/.exec(line);
    // `wc` ends a multi-file batch with a `total` line; listed paths all start with ./
    if (file) entries.set(file[2], Number(file[1]));
    const link = /^L \.\/(.+)$/.exec(line);
    if (link) links.add(link[1]);
    const done = /^S (\d+)$/.exec(line);
    if (done) status = Number(done[1]);
  }
  return {
    entries: [...entries].map(([entryPath, bytes]) => ({ path: entryPath, bytes })),
    links: [...links],
    truncated: status === null,
    status,
  };
}

/**
 * Media paths (relative to artifacts/) a PR body cites as local artifact
 * files: a path after its last `artifacts/` segment, or a relative path with a
 * directory, normalized like manifest paths (no `..`, absolute or URL paths).
 * Citations under screenshots/ or recipe-runs/ are dropped: the mirror deletes
 * the raw spool and non-promoted runs after copying, and the promoted snapshot
 * is copied whole.
 */
export function prBodyCitedArtifactPaths(body: string): string[] {
  const paths = new Set<string>();
  for (const [token] of body.matchAll(/[^\s<>()[\]'"`|]+\.(?:png|jpe?g|gif|mp4|mov|webm)/gi)) {
    if (token.includes('://')) continue;
    const marker = token.lastIndexOf('artifacts/');
    const candidate =
      marker >= 0 && (marker === 0 || token[marker - 1] === '/') ? token.slice(marker) : token;
    if (!candidate.replace(/^(?:\.\/)?(?:artifacts\/)?/, '').includes('/')) continue;
    const normalized = normalizeEvidenceManifestArtifactPath(candidate);
    if (!normalized) continue;
    const relative = normalized.slice('artifacts/'.length);
    if (/^(?:screenshots|recipe-runs)\//.test(relative)) continue;
    paths.add(relative);
  }
  return [...paths].sort();
}

/**
 * The scanned entries that belong in the package outside the promoted
 * snapshot: named files, step directories, and top-level text and media.
 * `dropped` lists the top-level files left out for their type.
 */
export function selectPublishPackageEntries(
  scanned: readonly PublishPackageEntry[],
  namedPaths: readonly string[],
): { entries: PublishPackageEntry[]; dropped: string[] } {
  const named = new Set(namedPaths);
  const entries: PublishPackageEntry[] = [];
  const dropped: string[] = [];
  for (const entry of scanned) {
    if (named.has(entry.path) || entry.path.includes('/')) {
      entries.push(entry);
    } else if (
      TOP_LEVEL_EXCLUDES.has(entry.path) ||
      isGatewayOwnedArtifactMirrorEntry(entry.path)
    ) {
      continue;
    } else if (TOP_LEVEL_KEPT_EXT.test(entry.path)) {
      entries.push(entry);
    } else {
      dropped.push(entry.path);
    }
  }
  return { entries, dropped };
}

/**
 * Files the promoted snapshot copy adds through symlinks, which the scan lists
 * but does not follow. slotCopyDir copies a link whose real path stays inside
 * the snapshot as its target (a file, or a directory walked in place) and
 * skips one that dangles, escapes or loops back onto an ancestor; the counted
 * files follow the same rule, sized from the target's scanned entries.
 */
export async function promotedSnapshotLinkEntries(
  scan: PublishPackageScan,
  snapshotRoot: string,
  realpathOf: (relativePath: string) => Promise<string | null>,
): Promise<PublishPackageEntry[]> {
  const snapshotLinks = scan.links.filter((link) => link.startsWith(`${snapshotRoot}/`));
  if (snapshotLinks.length === 0) return [];
  const rootReal = await realpathOf(snapshotRoot);
  if (!rootReal) return [];
  const added: PublishPackageEntry[] = [];
  for (const link of snapshotLinks) {
    const real = await realpathOf(link);
    if (!real) continue;
    const relative = path.posix.relative(rootReal, real);
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative))
      continue;
    const target = relative ? `${snapshotRoot}/${relative}` : snapshotRoot;
    if (link.startsWith(`${target}/`)) continue;
    for (const entry of scan.entries) {
      if (entry.path === target || entry.path.startsWith(`${target}/`)) {
        added.push({ path: `${link}${entry.path.slice(target.length)}`, bytes: entry.bytes });
      }
    }
  }
  return added;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Throw when the mirror would exceed PUBLISH_PACKAGE_MAX_BYTES or
 * PUBLISH_PACKAGE_MAX_FILES, naming the five largest directories (grouped two
 * levels under artifacts/) so the operator can see what to move out. A
 * truncated listing is over the file cap by construction.
 */
export function assertPublishPackageWithinCaps(
  entries: readonly PublishPackageEntry[],
  workerArtifactsDir: string,
  options: { maxBytes?: number; maxFiles?: number; truncated?: boolean } = {},
): void {
  const maxBytes = options.maxBytes ?? PUBLISH_PACKAGE_MAX_BYTES;
  const maxFiles = options.maxFiles ?? PUBLISH_PACKAGE_MAX_FILES;
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (!options.truncated && totalBytes <= maxBytes && entries.length <= maxFiles) return;
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
  const counted = options.truncated
    ? `more than ${entries.length} file(s) (listing stopped), at least ${formatBytes(totalBytes)}`
    : `${entries.length} file(s), ${formatBytes(totalBytes)}`;
  throw new Error(
    `publish package would mirror ${counted} from ${workerArtifactsDir}, ` +
      `over the cap of ${maxFiles} files / ${formatBytes(maxBytes)}. ` +
      `Largest directories: ${largest.join('; ')}. ` +
      'Keep clones, installs and scratch workspaces out of artifacts/.',
  );
}

/** Run the scan on the worker (one exec, local or remote) and parse its listing. */
export async function scanPublishPackage(
  vars: SlotVars,
  workerArtifactsDir: string,
  roots: PublishPackageScanRoots,
): Promise<PublishPackageScan> {
  const result = await execOnSlot(vars, buildPublishPackageScanCommand(workerArtifactsDir, roots), {
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const { status, ...scan } = parsePublishPackageScan(result.stdout);
  if (result.exitCode !== 0 || (status !== null && status !== 0)) {
    throw new Error(
      `publish package scan failed in ${workerArtifactsDir} (exit ${status ?? result.exitCode}): ${result.stderr.trim().slice(0, 500)}`,
    );
  }
  return scan;
}
