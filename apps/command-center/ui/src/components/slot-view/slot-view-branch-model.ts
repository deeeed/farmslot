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
