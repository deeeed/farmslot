export function canSaveSlotViewFile(params: {
  activeFile: string;
  isLive: boolean;
  saveFeedback: '' | 'saving' | 'saved';
  recoveryBlocked: boolean;
  activeTabType?: 'file' | 'diff' | null;
}): boolean {
  return Boolean(
    params.activeFile &&
    !params.activeFile.startsWith('branch:') &&
    params.isLive &&
    params.saveFeedback !== 'saving' &&
    !params.recoveryBlocked &&
    params.activeTabType === 'file',
  );
}
