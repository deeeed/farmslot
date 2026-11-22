import { shellQuote } from '../../core/tmux.js';

/**
 * Prepare must not change tracked files. A dependency step that re-serializes a
 * workspace manifest (Yarn 4 sorts dependencies on install, even with
 * --immutable) left every slot with a dirty checkout that only failed much
 * later, at run completion or slot reclaim. Prepare snapshots the tracked state
 * before its install phase and fails at the step that changed it.
 *
 * The baseline is taken after checkout and fixtures, so intended fixture writes
 * and the uncommitted work a replay preserves are not reported.
 */
export interface TrackedFilesSnapshot {
  head: string;
  /** Path -> blob hash of the worktree file, or 'deleted'. Only paths differing from HEAD. */
  dirty: Map<string, string>;
}

export function buildTrackedFilesSnapshotCommand(repo: string): string {
  return [
    `cd ${shellQuote(repo)}`,
    'git rev-parse HEAD',
    // NUL-separated paths survive spaces and newlines; --no-renames keeps one path per entry.
    `git -c core.quotepath=off diff --no-renames --name-only -z HEAD -- | while IFS= read -r -d '' p; do if [ -e "$p" ] || [ -L "$p" ]; then printf '%s\\t%s\\n' "$(git hash-object -- "$p")" "$p"; else printf 'deleted\\t%s\\n' "$p"; fi; done`,
  ].join(' && ');
}

export function parseTrackedFilesSnapshot(stdout: string): TrackedFilesSnapshot {
  const [head = '', ...lines] = stdout.split('\n');
  const dirty = new Map<string, string>();
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (tab > 0) dirty.set(line.slice(tab + 1), line.slice(0, tab));
  }
  return { head: head.trim(), dirty };
}

/** Tracked paths whose content differs between the two snapshots, sorted. */
export function changedTrackedFiles(
  before: TrackedFilesSnapshot,
  after: TrackedFilesSnapshot,
): string[] {
  const changed = new Set<string>();
  for (const [file, hash] of after.dirty) if (before.dirty.get(file) !== hash) changed.add(file);
  for (const file of before.dirty.keys()) if (!after.dirty.has(file)) changed.add(file);
  return [...changed].sort();
}

export function trackedFilesChangedMessage(
  phase: string,
  command: string,
  slotId: string,
  before: TrackedFilesSnapshot,
  after: TrackedFilesSnapshot,
): string | null {
  if (before.head !== after.head)
    return `prepare ${phase} moved HEAD on ${slotId} (${before.head.slice(0, 12)} -> ${after.head.slice(0, 12)}) — command: ${command}`;
  const files = changedTrackedFiles(before, after);
  if (files.length === 0) return null;
  return (
    `prepare ${phase} changed ${files.length} tracked file${files.length === 1 ? '' : 's'} on ${slotId}: ${files.join(', ')} — ` +
    `command: ${command}. Prepare must leave tracked files unchanged: commit the form the tool writes ` +
    `(for example sorted package.json dependencies) or make the step non-mutating.`
  );
}
