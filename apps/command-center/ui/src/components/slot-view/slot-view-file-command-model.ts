export function canSaveSlotViewFile(params: {
  activeFile: string;
  isLive: boolean;
  saveFeedback: '' | 'saving' | 'saved';
  recoveryBlocked: boolean;
  activeTabType?: 'file' | 'diff' | null;
  /** False keeps the file read-only (ADR-009 Amendment 1, decision 4). */
  editable?: boolean;
}): boolean {
  return Boolean(
    params.activeFile &&
    !params.activeFile.startsWith('branch:') &&
    params.isLive &&
    params.saveFeedback !== 'saving' &&
    !params.recoveryBlocked &&
    params.activeTabType === 'file' &&
    params.editable !== false,
  );
}
