export type SlotViewResizeType = 'sidebar' | 'terminal' | 'pinned' | 'stream' | 'review';

/** Bottom tab row above the terminal body. */
export const SLOT_VIEW_TERMINAL_TAB_HEIGHT = 28;
/** Minimum editor row height so tabs/content stay visible above the terminal. */
export const SLOT_VIEW_MIN_EDITOR_HEIGHT = 60;
/** Minimum terminal body height when the panel is open. */
export const SLOT_VIEW_MIN_TERMINAL_HEIGHT = 60;

/** Clamp persisted terminal height to the current right-column budget. */
export function computeEffectiveTerminalHeight(
  storedHeight: number,
  rightColHeight: number,
): number {
  if (rightColHeight <= 0) return storedHeight;
  const maxBody = Math.max(
    SLOT_VIEW_MIN_TERMINAL_HEIGHT,
    rightColHeight - SLOT_VIEW_TERMINAL_TAB_HEIGHT - SLOT_VIEW_MIN_EDITOR_HEIGHT,
  );
  return Math.max(SLOT_VIEW_MIN_TERMINAL_HEIGHT, Math.min(storedHeight, maxBody));
}

export function slotViewResizeCursor(type: SlotViewResizeType): 'col-resize' | 'row-resize' {
  return type === 'sidebar' || type === 'stream' || type === 'review' ? 'col-resize' : 'row-resize';
}

export function computeSlotViewResizeValue(params: {
  type: SlotViewResizeType;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  startValue: number;
  maxWidth?: number;
  maxHeight?: number;
}): number {
  const { type, startX, startY, clientX, clientY, startValue } = params;
  if (type === 'sidebar') {
    const delta = clientX - startX;
    return Math.max(150, Math.min(500, startValue + delta));
  }
  if (type === 'stream') {
    const maxWidth = params.maxWidth ?? 1200;
    const delta = startX - clientX;
    return Math.max(180, Math.min(maxWidth, startValue + delta));
  }
  if (type === 'review') {
    const maxWidth = params.maxWidth ?? 1200;
    const delta = startX - clientX;
    return Math.max(300, Math.min(maxWidth, startValue + delta));
  }
  if (type === 'pinned') {
    const delta = clientY - startY;
    return Math.max(60, Math.min(500, startValue + delta));
  }

  const maxHeight = params.maxHeight ?? 800;
  const delta = startY - clientY;
  return Math.max(60, Math.min(maxHeight, startValue + delta));
}
