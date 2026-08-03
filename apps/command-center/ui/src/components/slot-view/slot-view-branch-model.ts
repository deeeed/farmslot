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

/**
 * Decide whether the git-status poll should (re)load the branch diff. The
 * diff is otherwise fetched once at view init, so the poll is the only
 * recovery path: a transiently failed load (node reconnecting, gateway
 * restart) or a commit count change must trigger a reload, or the panel
 * shows "No changes" forever while the branch is ahead.
 */
export function shouldReloadBranchDiff({
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
}): boolean {
  if (loading) return false;
  if (prevBranch !== undefined && nextBranch !== prevBranch) return true;
  if (prevAhead !== undefined && nextAhead !== prevAhead) return true;
  if (lastLoadFailed) return true;
  return false;
}
