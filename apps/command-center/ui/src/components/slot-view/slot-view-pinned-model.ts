const TASK_DIR_MARKERS = [
  '.sandbox/farmslot-farm/worker-task/',
  '.sandbox/farmslot-farm/task/',
  'worker-task/',
  'tasks/',
  'temp/tasks/',
  '.task/',
  'temp/.task/',
] as const;

function taskRelPathFromTaskFile(taskFile: string): string | null {
  const normalized = taskFile.replace(/\\/g, '/');
  if (!normalized.endsWith('TASK.md')) return null;
  const dir = normalized.replace(/\/?TASK\.md$/, '');
  for (const marker of TASK_DIR_MARKERS) {
    const idx = dir.lastIndexOf(marker);
    if (idx >= 0) {
      return dir.slice(idx + marker.length);
    }
  }
  return null;
}

/** Parent directory of TASK.md when taskFile is already slot-relative (e.g. agent context). */
export function slotViewPinnedFolderFromTaskFile(taskFile: string): string | null {
  const normalized = taskFile.replace(/\\/g, '/');
  if (!normalized.endsWith('TASK.md') || normalized.startsWith('/')) return null;
  return normalized.replace(/\/?TASK\.md$/, '');
}

export function slotViewTaskRelativePath(params: {
  runTaskFile?: string | null;
  slotTaskFile?: string | null;
  slotAgentTaskFile?: string | null;
  showTaskUi: boolean;
}): string | null {
  if (params.slotAgentTaskFile) {
    const fromAgent = taskRelPathFromTaskFile(params.slotAgentTaskFile);
    if (fromAgent) return fromAgent;
  }

  if (params.runTaskFile) {
    const fromRun = taskRelPathFromTaskFile(params.runTaskFile);
    if (fromRun) return fromRun;
  }

  if (params.showTaskUi && params.slotTaskFile) return params.slotTaskFile;
  return null;
}

export function slotViewPinnedFolderCandidates(taskRelPath: string): string[] {
  return [
    `.sandbox/farmslot-farm/worker-task/${taskRelPath}`,
    `.sandbox/farmslot-farm/task/${taskRelPath}`,
    `temp/tasks/${taskRelPath}`,
    `tasks/${taskRelPath}`,
    `.task/${taskRelPath}`,
    `temp/.task/${taskRelPath}`,
  ];
}
