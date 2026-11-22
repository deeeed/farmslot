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
  /**
   * Submodule path -> "<HEAD gitlink> <checked-out commit>". Recorded directly
   * because `git stash create` and `git diff` honor `submodule.<name>.ignore`.
   */
  submodules: Map<string, string>;
}

const SNAPSHOT_FIELDS = 4;

export function buildTrackedFilesSnapshotCommand(repo: string): string {
  return [
    `cd ${shellQuote(repo)}`,
    'head=$(git rev-parse --verify HEAD)',
    'branch=$(git symbolic-ref -q HEAD || true)',
    // `git stash create` needs a merged index; a replay can keep a conflicted one.
    "{ [ -z \"$(git ls-files -u | head -n 1)\" ] || { printf '%s\\n' unmerged; exit 0; }; }",
    // A file rewritten with identical bytes is only stat-dirty; `git stash create`
    // exits 1 without output on that, so refresh the stat cache first.
    '{ git update-index -q --refresh >/dev/null 2>&1 || true; }',
    // Only the stash commit's trees are compared, so a fixed identity keeps slots
    // without a configured committer working.
    'stash=$(git -c user.name=farmslot -c user.email=prepare@farmslot.invalid stash create)',
    // A clean checkout has no stash commit: worktree and index are HEAD's tree.
    'base=${stash:-$head}',
    'worktree=$(git rev-parse --verify "$base^{tree}")',
    'index=$(if [ -n "$stash" ]; then git rev-parse --verify "$stash^2^{tree}"; else git rev-parse --verify "$head^{tree}"; fi)',
    `printf '%s\\n%s\\n%s\\n%s\\n' "$head" "$branch" "$worktree" "$index"`,
    // One line per gitlink in HEAD: "<HEAD gitlink> <checked-out commit or none>\t<path>".
    // Gitlinks are filtered before the loop: large repos list tens of thousands of entries.
    `{ git -c core.quotepath=off ls-tree -r HEAD | { grep '^160000 commit ' || true; } | while IFS=$'\\t' read -r meta p; do printf '%s %s\\t%s\\n' "\${meta##* }" "$(if [ -e "$p/.git" ]; then git -C "$p" rev-parse -q --verify HEAD 2>/dev/null || echo none; else echo none; fi)" "$p"; done; }`,
  ].join(' && ');
}

/** Null when the index has unmerged entries and no tree can be recorded. */
export function parseTrackedFilesSnapshot(stdout: string): TrackedFilesSnapshot | null {
  if (stdout.trim() === 'unmerged') return null;
  const lines = stdout.split('\n');
  const [head = '', branch = '', worktreeTree = '', indexTree = ''] = lines;
  const object = /^[0-9a-f]{40,64}$/;
  if (
    lines.length < SNAPSHOT_FIELDS ||
    ![head, worktreeTree, indexTree].every((v) => object.test(v))
  )
    throw new Error(`unreadable tracked-file snapshot: ${JSON.stringify(stdout.slice(0, 300))}`);
  const submodules = new Map<string, string>();
  for (const line of lines.slice(SNAPSHOT_FIELDS)) {
    const tab = line.indexOf('\t');
    if (tab > 0) submodules.set(line.slice(tab + 1), line.slice(0, tab));
  }
  return { head, branch, worktreeTree, indexTree, submodules };
}

export function snapshotsEqual(a: TrackedFilesSnapshot, b: TrackedFilesSnapshot): boolean {
  return (
    a.head === b.head &&
    a.branch === b.branch &&
    a.worktreeTree === b.worktreeTree &&
    a.indexTree === b.indexTree &&
    changedSubmodules(a, b).length === 0 &&
    a.submodules.size === b.submodules.size
  );
}

/** Submodules whose checked-out commit changed and no longer matches HEAD's gitlink. */
export function changedSubmodules(before: TrackedFilesSnapshot, after: TrackedFilesSnapshot): string[] {
  const changed: string[] = [];
  for (const [file, state] of after.submodules) {
    const [gitlink, current] = state.split(' ');
    const previous = before.submodules.get(file)?.split(' ')[1];
    if (current !== previous && current !== gitlink) changed.push(file);
  }
  return changed;
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
    .map(([a, b]) => `git diff --no-renames --ignore-submodules=none --name-only -z ${shellQuote(a)} ${shellQuote(b)} --`);
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
