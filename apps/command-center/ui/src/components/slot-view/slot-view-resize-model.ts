export type SlotViewResizeType = 'sidebar' | 'terminal' | 'pinned' | 'stream' | 'review';

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
