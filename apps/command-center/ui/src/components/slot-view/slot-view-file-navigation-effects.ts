import type { SlotView } from './slot-view.js';
import { resolveSlotViewOpenFilePath } from './slot-view-file-navigation-model.js';
import { parseBranchDiffKey, realPath } from './slot-view-model.js';

export async function navigateSlotViewComment(
  view: SlotView,
  detail: { path: string; line: number | null },
): Promise<void> {
  // Auto-enable inline comments when navigating from comments panel.
  view._showInlineComments = true;
  view._revealLine = 0;
  await view._handleFileSelect(detail.path);
  if (detail.line) {
    // Double-RAF: first lets Lit update the DOM, second lets Monaco render.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        view._revealLine = detail.line!;
      }),
    );
  }
}

export async function openSlotViewIndexedFile(
  view: SlotView,
  path: string,
  line: number,
): Promise<void> {
  const resolvedPath = resolveSlotViewOpenFilePath(view._fileIndex, path);
  view._revealLine = 0;
  await view._handleFileSelect(resolvedPath);
  if (line > 0) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        view._revealLine = line;
      }),
    );
  }
}

export function handleSlotViewGlyphClick(view: SlotView, line: number): void {
  if (!view._prNumber || !view._activeFile) return;
  const frozenHead = parseBranchDiffKey(view._activeFile)?.head;
  // Switch to comments tab and signal the panel to start a new comment.
  view._bottomTab = 'comments';
  view._terminalOpen = true;
  requestAnimationFrame(() => {
    const panel = view.querySelector('pr-comments-panel');
    if (panel) {
      panel.dispatchEvent(
        new CustomEvent('start-new-comment', {
          detail: {
            path: realPath(view._activeFile),
            line,
            ...(frozenHead && frozenHead !== 'HEAD' ? { commitId: frozenHead } : {}),
          },
        }),
      );
    }
  });
}
