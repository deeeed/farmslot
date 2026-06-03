export type ArtifactStickyChromeLayout = {
  y: number;
  height: number;
};

export function artifactStickyChromeThreshold(
  layout: ArtifactStickyChromeLayout | null,
  fallbackThreshold: number,
  activationLead = 0,
  maxThreshold = Number.POSITIVE_INFINITY,
): number {
  const lead = Number.isFinite(activationLead) ? Math.max(0, activationLead) : 0;
  const cap = Number.isFinite(maxThreshold) ? Math.max(0, maxThreshold) : Number.POSITIVE_INFINITY;
  if (!layout || !Number.isFinite(layout.y) || !Number.isFinite(layout.height)) {
    return Math.min(cap, Math.max(0, fallbackThreshold - lead));
  }

  return Math.min(cap, Math.max(0, layout.y - lead));
}

export function artifactStickyChromeVisible(scrollOffsetY: number, threshold: number): boolean {
  if (!Number.isFinite(scrollOffsetY)) return false;
  return scrollOffsetY > Math.max(0, threshold);
}
