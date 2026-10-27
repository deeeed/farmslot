import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import type { SlotView } from './slot-view.js';
import {
  editSlotViewFile,
  saveSlotViewDraft,
  slotViewDraftIdentity,
  slotViewEditable,
} from './slot-view-edit-effects.js';
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

export type SlotViewGitActionMethod =
  | typeof Methods.GIT_STAGE
  | typeof Methods.GIT_UNSTAGE
  | typeof Methods.GIT_DISCARD;

export function setSlotViewEditor(view: SlotView, id: EditorId): void {
  view._editor = id;
  localStorage.setItem(EDITOR_PREF_KEY, id);
}

export async function runSlotViewGitAction(
  view: SlotView,
  method: SlotViewGitActionMethod,
  path: string,
): Promise<void> {
  if (!view._isLive || view._isRecoveryBlocked || !view._workspaceReads.ready) return;
  try {
    await gateway.request(method, { slotId: view.slotId, path });
    // The existing workspace source publishes after the git writer becomes visible.
  } catch (err) {
    console.error(`[slot-view] ${method} failed:`, err);
  }
}

/** An explicit save: the editor's text becomes the file's draft, saved under its preconditions. */
export async function saveSlotViewFile(view: SlotView): Promise<void> {
  const path = view._activeFile;
  const tab = view._openFiles.find((file) => file.path === path);
  if (
    !canSaveSlotViewFile({
      activeFile: path,
      isLive: view._isLive,
      saveFeedback: view._saveFeedback,
      recoveryBlocked: view._isRecoveryBlocked,
      activeTabType: tab?.type,
      editable: slotViewEditable(view, path),
    })
  ) {
    return;
  }

  // Save belongs to the draft shown when it was pressed; a view that moved on saves nothing.
  const identity = slotViewDraftIdentity(view, path);
  const pressed = () => identity !== undefined && slotViewDraftIdentity(view, path) === identity;
  const codeViewer = view.querySelector('code-viewer') as CodeViewerElement | null;
  const content = codeViewer?._editor?.getValue();
  const shown = view._fileDrafts.get(path)?.editedContent ?? view._liveFileContents.get(path);
  if (content !== undefined && content !== shown) await editSlotViewFile(view, path, content);
  if (!pressed() || !view._fileDrafts.has(path) || !(await saveSlotViewDraft(view, path))) return;
  if (!pressed()) return;
  view._pinFile(path);
  // Auto-refresh diagnostics if they've been loaded.
  if (view._diagnostics.length > 0 || view._diagnosticsLoading) {
    view._runDiagnostics();
  }
}
