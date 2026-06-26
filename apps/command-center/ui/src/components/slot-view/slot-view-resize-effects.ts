import type { SlotView } from './slot-view.js';
import {
  computeEffectiveTerminalHeight,
  computeSlotViewResizeValue,
  slotViewResizeCursor,
  type SlotViewResizeType,
} from './slot-view-resize-model.js';

export { type SlotViewResizeType } from './slot-view-resize-model.js';

export function startSlotViewResize(
  view: SlotView,
  type: SlotViewResizeType,
  event: MouseEvent,
): void {
  event.preventDefault();
  view._resizing = type;
  view._resizeStartX = event.clientX;
  view._resizeStartY = event.clientY;
  view._resizeStartValue = slotViewResizeStartValue(view, type);
  document.addEventListener('mousemove', view._onResizeMove);
  document.addEventListener('mouseup', view._onResizeEnd);
  document.body.style.cursor = slotViewResizeCursor(type);
  document.body.style.userSelect = 'none';
}

export function moveSlotViewResize(view: SlotView, event: MouseEvent): void {
  if (!view._resizing) return;
  const maxWidth = slotViewResizeMaxWidth(view, view._resizing);
  const maxHeight = slotViewResizeMaxHeight(view, view._resizing);
  const nextValue = computeSlotViewResizeValue({
    type: view._resizing,
    startX: view._resizeStartX,
    startY: view._resizeStartY,
    clientX: event.clientX,
    clientY: event.clientY,
    startValue: view._resizeStartValue,
    ...(maxWidth !== undefined ? { maxWidth } : {}),
    ...(maxHeight !== undefined ? { maxHeight } : {}),
  });
  applySlotViewResizeValue(view, view._resizing, nextValue);
}

export function endSlotViewResize(view: SlotView): void {
  view._resizing = null;
  document.removeEventListener('mousemove', view._onResizeMove);
  document.removeEventListener('mouseup', view._onResizeEnd);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  view._saveLayout();
}

function slotViewResizeStartValue(view: SlotView, type: SlotViewResizeType): number {
  if (type === 'sidebar') return view._sidebarWidth;
  if (type === 'pinned') return view._pinnedHeight;
  if (type === 'stream') return view._streamWidth;
  if (type === 'review') return view._reviewPanelWidth;
  return view._terminalHeight;
}

function slotViewResizeMaxWidth(view: SlotView, type: SlotViewResizeType): number | undefined {
  if (type !== 'stream' && type !== 'review') return undefined;
  const editorRow = view.querySelector('.sv-editor-row') as HTMLElement | null;
  return editorRow ? editorRow.offsetWidth - 200 : 1200;
}

function slotViewResizeMaxHeight(view: SlotView, type: SlotViewResizeType): number | undefined {
  if (type !== 'terminal') return undefined;
  const rightColHeight = slotViewRightColHeight(view);
  if (rightColHeight <= 0) return 800;
  return computeEffectiveTerminalHeight(Number.MAX_SAFE_INTEGER, rightColHeight);
}

export function slotViewEffectiveTerminalHeight(view: SlotView): number {
  return computeEffectiveTerminalHeight(
    view._terminalHeight,
    view._rightColHeight || slotViewRightColHeight(view),
  );
}

function slotViewRightColHeight(view: SlotView): number {
  const rightCol = view.querySelector('.sv-right-col') as HTMLElement | null;
  return rightCol?.clientHeight ?? 0;
}

export function connectSlotViewLayoutObserver(view: SlotView): void {
  disconnectSlotViewLayoutObserver(view);
  const attach = () => {
    const rightCol = view.querySelector('.sv-right-col') as HTMLElement | null;
    if (!rightCol) return;
    view._rightColObserver = new ResizeObserver((entries) => {
      const height = Math.round(entries[0]?.contentRect.height ?? 0);
      if (height !== view._rightColHeight) {
        view._rightColHeight = height;
      }
    });
    view._rightColObserver.observe(rightCol);
    view._rightColHeight = rightCol.clientHeight;
  };
  requestAnimationFrame(attach);
}

export function disconnectSlotViewLayoutObserver(view: SlotView): void {
  view._rightColObserver?.disconnect();
  view._rightColObserver = undefined;
}

function applySlotViewResizeValue(view: SlotView, type: SlotViewResizeType, value: number): void {
  if (type === 'sidebar') {
    view._sidebarWidth = value;
  } else if (type === 'stream') {
    view._streamWidth = value;
  } else if (type === 'review') {
    view._reviewPanelWidth = value;
  } else if (type === 'pinned') {
    view._pinnedHeight = value;
  } else {
    view._terminalHeight = value;
    view._rightColHeight = slotViewRightColHeight(view) || view._rightColHeight;
  }
}
