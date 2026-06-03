export function slotViewTaskRelativePath(params: {
  runTaskFile?: string | null;
  slotTaskFile?: string | null;
  showTaskUi: boolean;
}): string | null {
  const runTaskFile = params.runTaskFile;
  if (runTaskFile && runTaskFile.includes('/tasks/')) {
    return runTaskFile.split('/tasks/')[1].replace('/TASK.md', '');
  }

  if (params.showTaskUi && params.slotTaskFile) return params.slotTaskFile;
  return null;
}

export function slotViewPinnedFolderCandidates(taskRelPath: string): string[] {
  return [
    `temp/tasks/${taskRelPath}`,
    `tasks/${taskRelPath}`,
    `.task/${taskRelPath}`,
    `temp/.task/${taskRelPath}`,
  ];
}
