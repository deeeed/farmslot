export function slotViewBranchList({
  branchDiffBase,
  branchDiffHead,
  gitBranch,
}: {
  branchDiffBase: string;
  branchDiffHead: string;
  gitBranch?: string;
}) {
  const branches = new Set<string>();
  branches.add('main');
  branches.add('develop');
  if (branchDiffHead && branchDiffHead !== 'main') branches.add(branchDiffHead);
  if (branchDiffBase && branchDiffBase !== 'main') branches.add(branchDiffBase);
  if (gitBranch) branches.add(gitBranch);
  return [...branches].sort();
}

export type BranchDiffPollAction = 'none' | 'reload' | 'reload-and-clear-cache';

/**
 * Decide what the git-status poll should do about the branch diff. The diff
 * is otherwise fetched once at view init, so the poll is the only recovery
 * path: a transiently failed load (node reconnecting, gateway restart) or a
 * commit count change must trigger a reload, or the panel shows "No changes"
 * forever while the branch is ahead. Git movement (branch or ahead change)
 * also invalidates cached per-file diff contents; a retry after a failed
 * load does not — the underlying commits did not change.
 */
export function branchDiffPollAction({
  prevBranch,
  nextBranch,
  prevAhead,
  nextAhead,
  lastLoadFailed,
  loading,
}: {
  prevBranch: string | undefined;
  nextBranch: string;
  prevAhead: number | undefined;
  nextAhead: number;
  lastLoadFailed: boolean;
  loading: boolean;
}): BranchDiffPollAction {
  if (loading) return 'none';
  const branchChanged = prevBranch !== undefined && nextBranch !== prevBranch;
  const aheadChanged = prevAhead !== undefined && nextAhead !== prevAhead;
  if (branchChanged || aheadChanged) return 'reload-and-clear-cache';
  if (lastLoadFailed) return 'reload';
  return 'none';
}
