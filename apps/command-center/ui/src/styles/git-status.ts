// Single source of truth for git file-state visuals across Command Center —
// the source-control panel, the branch-diff activity, and the file tree must
// speak the same color/letter language (IDE convention: VSCode-style SCM).

export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | '?';

export function gitStatusColor(status: GitFileStatus): string {
  switch (status) {
    case 'M':
      return '#6366f1'; // modified — accent
    case 'A':
      return '#00ff88'; // added — green
    case 'D':
      return '#ff4444'; // deleted — red
    case 'R':
      return '#ffcc00'; // renamed — amber
    case '?':
      return '#00ff88'; // untracked — green, same family as added
  }
}

export interface GitStateChip {
  /** Single-letter badge, IDE-style. */
  label: 'C' | 'S' | 'M' | 'U';
  color: string;
  title: string;
}

/**
 * Per-file state chips for a unified (worktree-scope) diff row. Answers
 * "committed, staged, unstaged, or untracked?" at a glance:
 *   C — has committed changes vs the base branch
 *   S — has staged (index) changes
 *   M — has unstaged working-tree modifications
 *   U — untracked (never committed, not in the index)
 * A file can carry several chips at once (e.g. C+S+M).
 */
export function gitStateChips(input: {
  committed: boolean | undefined;
  worktreeEntries: Array<{ status: string; staged: boolean }>;
}): GitStateChip[] {
  const chips: GitStateChip[] = [];
  if (input.committed) {
    chips.push({ label: 'C', color: '#8b8cf1', title: 'Committed changes vs base' });
  }
  const untracked = input.worktreeEntries.some((entry) => entry.status === '?');
  if (input.worktreeEntries.some((entry) => entry.staged)) {
    chips.push({ label: 'S', color: '#00ff88', title: 'Staged changes' });
  }
  if (input.worktreeEntries.some((entry) => !entry.staged && entry.status !== '?')) {
    chips.push({ label: 'M', color: '#ffcc00', title: 'Unstaged modifications' });
  }
  if (untracked) {
    chips.push({ label: 'U', color: '#8a9a8a', title: 'Untracked file' });
  }
  return chips;
}
