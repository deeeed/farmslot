import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import type { SlotView } from './slot-view.js';
import { canSaveSlotViewFile } from './slot-view-file-command-model.js';
import type { CodeViewerElement, EditorId } from './slot-view-model.js';
import { EDITOR_PREF_KEY } from './slot-view-model.js';

export async function openSlotViewEditor(view: SlotView): Promise<void> {
  try {
    await gateway.request(Methods.SLOT_OPEN_EDITOR, {
      slotId: view.slotId,
      editor: view._editor,
    });
  } catch (err) {
    console.error('[slot-view] openEditor failed:', err);
  }
}

export async function revealSlotViewArtifacts(view: SlotView): Promise<void> {
  const taskFile = view._slot?.taskFile;
  if (!taskFile) return;
  try {
    await gateway.request(Methods.FS_REVEAL, {
      slotId: view.slotId,
      path: `temp/.task/${taskFile}/artifacts`,
    });
  } catch (err) {
    console.error('[slot-view] revealArtifacts failed:', err);
  }
}

export function setSlotViewEditor(view: SlotView, id: EditorId): void {
  view._editor = id;
  localStorage.setItem(EDITOR_PREF_KEY, id);
}

export async function runSlotViewGitAction(
  view: SlotView,
  method: string,
  path: string,
): Promise<void> {
  if (!view._isLive || view._isRecoveryBlocked) return;
  try {
    await gateway.request(method, { slotId: view.slotId, path });
    // Refresh git status after action.
    await view._refreshGitStatus();
  } catch (err) {
    console.error(`[slot-view] ${method} failed:`, err);
  }
}

export async function saveSlotViewFile(view: SlotView): Promise<void> {
  const tab = view._openFiles.find((file) => file.path === view._activeFile);
  if (
    !canSaveSlotViewFile({
      activeFile: view._activeFile,
      isLive: view._isLive,
      saveFeedback: view._saveFeedback,
      recoveryBlocked: view._isRecoveryBlocked,
      activeTabType: tab?.type,
    })
  ) {
    return;
  }

  const codeViewer = view.querySelector('code-viewer') as CodeViewerElement | null;
  if (!codeViewer?._editor) return;
  const content = codeViewer._editor.getValue();
  view._saveFeedback = 'saving';
  try {
    await gateway.request(Methods.FS_WRITE, {
      slotId: view.slotId,
      path: view._activeFile,
      content,
    });
    const next = new Map(view._liveFileContents);
    next.set(view._activeFile, content);
    view._liveFileContents = next;
    view._pinFile(view._activeFile);
    view._saveFeedback = 'saved';
    setTimeout(() => {
      view._saveFeedback = '';
    }, 2000);
    // Auto-refresh diagnostics if they've been loaded.
    if (view._diagnostics.length > 0 || view._diagnosticsLoading) {
      view._runDiagnostics();
    }
  } catch (err) {
    console.error('[slot-view] save failed:', err);
    view._saveFeedback = '';
  }
}
