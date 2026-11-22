import { shellQuote } from '../../core/tmux.js';

/**
 * Prepare must not change tracked files. A dependency step that re-serializes a
 * workspace manifest (Yarn 4 sorts dependencies on install, even with
 * --immutable) left every slot with a dirty checkout that only failed much
 * later, at run completion or slot reclaim. Prepare snapshots the tracked state
 * after checkout and fixtures and checks it at each later phase boundary.
 *
 * The snapshot is git's own view, not a file walk: `git stash create` records the
 * worktree and index as trees without touching refs, the index or the files, so
 * symlinks, submodule gitlinks, deletions and any filename compare exactly.
 * Intended fixture writes and the uncommitted work a replay preserves are part
 * of the baseline. A phase may restore a file to HEAD; it may not leave a
 * tracked path different from HEAD that it was not before.
 */
export interface TrackedFilesSnapshot {
  head: string;
  /** Symbolic ref HEAD points at, or '' when detached. */
  branch: string;
  worktreeTree: string;
  indexTree: string;
}

const SNAPSHOT_FIELDS = 4;

export function buildTrackedFilesSnapshotCommand(repo: string): string {
  return [
    `cd ${shellQuote(repo)}`,
    'head=$(git rev-parse --verify HEAD)',
    'branch=$(git symbolic-ref -q HEAD || true)',
    'stash=$(git stash create)',
    // A clean checkout has no stash commit: worktree and index are HEAD's tree.
    'base=${stash:-$head}',
    'worktree=$(git rev-parse --verify "$base^{tree}")',
    'index=$(if [ -n "$stash" ]; then git rev-parse --verify "$stash^2^{tree}"; else git rev-parse --verify "$head^{tree}"; fi)',
    `printf '%s\\n%s\\n%s\\n%s\\n' "$head" "$branch" "$worktree" "$index"`,
  ].join(' && ');
}

export function parseTrackedFilesSnapshot(stdout: string): TrackedFilesSnapshot {
  const lines = stdout.split('\n');
  const [head = '', branch = '', worktreeTree = '', indexTree = ''] = lines;
  const object = /^[0-9a-f]{40,64}$/;
  if (lines.length < SNAPSHOT_FIELDS || ![head, worktreeTree, indexTree].every((v) => object.test(v)))
    throw new Error(`unreadable tracked-file snapshot: ${JSON.stringify(stdout.slice(0, 300))}`);
  return { head, branch, worktreeTree, indexTree };
}

export function snapshotsEqual(a: TrackedFilesSnapshot, b: TrackedFilesSnapshot): boolean {
  return (
    a.head === b.head &&
    a.branch === b.branch &&
    a.worktreeTree === b.worktreeTree &&
    a.indexTree === b.indexTree
  );
}

/** Paths that differ between the two snapshots' worktree or index trees (NUL-separated). */
export function buildChangedPathsCommand(
  repo: string,
  before: TrackedFilesSnapshot,
  after: TrackedFilesSnapshot,
): string {
  return diffTreesCommand(repo, [
    [before.worktreeTree, after.worktreeTree],
    [before.indexTree, after.indexTree],
  ]);
}

/** Paths where the snapshot's worktree or index differs from its HEAD (NUL-separated). */
export function buildDirtyPathsCommand(repo: string, snapshot: TrackedFilesSnapshot): string {
  return diffTreesCommand(repo, [
    [snapshot.head, snapshot.worktreeTree],
    [snapshot.head, snapshot.indexTree],
  ]);
}

function diffTreesCommand(repo: string, pairs: Array<[string, string]>): string {
  const diffs = pairs
    .filter(([a, b]) => a !== b)
    .map(([a, b]) => `git diff --no-renames --name-only -z ${shellQuote(a)} ${shellQuote(b)} --`);
  return `cd ${shellQuote(repo)} && { ${diffs.join(' && ') || 'true'}; }`;
}

/** Changed by the phase and not back at HEAD: restoring a file to HEAD is allowed. */
export function changedTrackedFiles(changed: string[], dirtyAfter: string[]): string[] {
  const dirty = new Set(dirtyAfter);
  return [...new Set(changed)].filter((file) => dirty.has(file)).sort();
}

export function parseNulPaths(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean);
}

export function trackedFilesChangedMessage(
  phase: string,
  command: string,
  slotId: string,
  before: TrackedFilesSnapshot,
  after: TrackedFilesSnapshot,
  files: string[],
): string | null {
  if (before.head !== after.head)
    return `prepare ${phase} moved HEAD on ${slotId} (${before.head.slice(0, 12)} -> ${after.head.slice(0, 12)}) — command: ${command}`;
  if (before.branch !== after.branch)
    return `prepare ${phase} switched branch on ${slotId} (${before.branch || 'detached'} -> ${after.branch || 'detached'}) — command: ${command}`;
  if (files.length === 0) return null;
  return (
    `prepare ${phase} changed ${files.length} tracked file${files.length === 1 ? '' : 's'} on ${slotId}: ${files.join(', ')} — ` +
    `command: ${command}. Prepare must leave tracked files unchanged: commit the form the tool writes ` +
    `(for example sorted package.json dependencies) or make the step non-mutating.`
  );
}
