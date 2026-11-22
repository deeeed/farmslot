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
  /**
   * The index has unmerged entries (a replay can keep a conflicted index), so no
   * trees were recorded; only HEAD and branch compare.
   */
  unmerged: boolean;
  worktreeTree: string;
  indexTree: string;
  /**
   * Submodule path -> "<HEAD gitlink> <checked-out commit|none> <hash of its diff to HEAD|clean>".
   * Recorded directly because `git stash create` and `git diff` honor
   * `submodule.<name>.ignore`, while completion checks with --ignore-submodules=none.
   */
  submodules: Map<string, string>;
}

const HEADER_LINES = 4;

// Single-quoted TS strings: shell ${...} stays literal; '\t' is a real tab.
// Runs under `bash -o pipefail`: a failed probe fails the snapshot instead of reading as clean.
const SUBMODULE_RECORDS = [
  // NUL-delimited end to end: ls-tree quotes unusual paths in line mode.
  "git ls-tree -r -z HEAD | perl -0ne 'print if /^160000 commit /' | while IFS= read -r -d '' entry; do",
  'meta=${entry%%\t*}; p=${entry#*\t}; commit=none; dirty=clean;',
  'if [ -e "$p/.git" ]; then',
  'commit=$(git -C "$p" rev-parse --verify HEAD) || exit 1;',
  // What completion's --ignore-submodules=none sees: unstaged and staged edits
  // and untracked files.
  'dirty=$({ git -C "$p" diff --binary --no-ext-diff HEAD -- && git -C "$p" diff --cached --binary --no-ext-diff HEAD -- && git -C "$p" status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none; } | git hash-object --stdin) || exit 1;',
  '[ "$dirty" = "$empty" ] && dirty=clean;',
  'fi;',
  'printf \'%s %s %s\\t%s\\0\' "${meta##* }" "$commit" "$dirty" "$p";',
  'done',
].join(' ');

export function buildTrackedFilesSnapshotCommand(repo: string): string {
  const merged = [
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
    'empty=$(git hash-object --stdin </dev/null)',
    'printf \'%s\\n%s\\n%s\\n%s\\n\' "$head" "$branch" "$worktree" "$index"',
    `{ ${SUBMODULE_RECORDS}; }`,
  ].join(' && ');
  const script = [
    `cd ${shellQuote(repo)}`,
    'head=$(git rev-parse --verify HEAD)',
    'branch=$(git symbolic-ref -q HEAD || true)',
    // `git stash create` needs a merged index.
    `if [ -n "$(git ls-files -u | head -n 1)" ]; then printf '%s\\n%s\\nunmerged\\n\\n' "$head" "$branch"; else ${merged}; fi`,
  ].join(' && ');
  return `bash -o pipefail -c ${shellQuote(script)}`;
}

export function parseTrackedFilesSnapshot(stdout: string): TrackedFilesSnapshot {
  const header: string[] = [];
  let rest = stdout;
  for (let i = 0; i < HEADER_LINES; i++) {
    const nl = rest.indexOf('\n');
    if (nl < 0) break;
    header.push(rest.slice(0, nl));
    rest = rest.slice(nl + 1);
  }
  const [head = '', branch = '', worktreeTree = '', indexTree = ''] = header;
  const object = /^[0-9a-f]{40,64}$/;
  const unmerged = worktreeTree === 'unmerged';
  if (
    header.length < HEADER_LINES ||
    !object.test(head) ||
    (!unmerged && !(object.test(worktreeTree) && object.test(indexTree)))
  )
    throw new Error(`unreadable tracked-file snapshot: ${JSON.stringify(stdout.slice(0, 300))}`);
  const submodules = new Map<string, string>();
  for (const record of rest.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab > 0) submodules.set(record.slice(tab + 1), record.slice(0, tab));
  }
  return unmerged
    ? { head, branch, unmerged, worktreeTree: '', indexTree: '', submodules: new Map() }
    : { head, branch, unmerged, worktreeTree, indexTree, submodules };
}

export function snapshotsEqual(a: TrackedFilesSnapshot, b: TrackedFilesSnapshot): boolean {
  return (
    a.head === b.head &&
    a.branch === b.branch &&
    a.unmerged === b.unmerged &&
    a.worktreeTree === b.worktreeTree &&
    a.indexTree === b.indexTree &&
    a.submodules.size === b.submodules.size &&
    [...a.submodules].every(([file, state]) => b.submodules.get(file) === state)
  );
}

/**
 * Submodules whose checkout (commit or uncommitted content) changed and is not
 * back at HEAD's gitlink with a clean tree.
 */
export function changedSubmodules(
  before: TrackedFilesSnapshot,
  after: TrackedFilesSnapshot,
): string[] {
  const changed: string[] = [];
  for (const [file, state] of after.submodules) {
    const [gitlink, commit, dirty] = state.split(' ');
    const previous = before.submodules.get(file)?.split(' ').slice(1).join(' ');
    if (`${commit} ${dirty}` !== previous && !(commit === gitlink && dirty === 'clean'))
      changed.push(file);
  }
  return changed.sort();
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
    .map(
      ([a, b]) =>
        `git diff --no-renames --ignore-submodules=none --name-only -z ${shellQuote(a)} ${shellQuote(b)} --`,
    );
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
