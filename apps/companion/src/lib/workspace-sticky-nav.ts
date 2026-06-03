export type WorkspaceStickyNavLayout = {
  y: number;
  height: number;
};

export const WORKSPACE_STICKY_NAV_FALLBACK_THRESHOLD = 1_000_000;

export function workspaceStickyNavThreshold(
  layout: WorkspaceStickyNavLayout | null,
  fallbackThreshold = WORKSPACE_STICKY_NAV_FALLBACK_THRESHOLD,
): number {
  if (!layout || !Number.isFinite(layout.y) || !Number.isFinite(layout.height)) {
    return Math.max(0, fallbackThreshold);
  }

  return Math.max(0, layout.y);
}
