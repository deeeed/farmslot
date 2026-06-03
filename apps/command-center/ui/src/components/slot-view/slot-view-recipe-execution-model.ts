export function completedSlotViewRecipeRunId(requestId?: string | null): string | null {
  return requestId ? `live-run:${requestId}` : null;
}
