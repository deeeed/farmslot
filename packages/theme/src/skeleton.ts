import { publicationGateColors } from './publication-gate';

export type SkeletonKind = 'line' | 'block' | 'row' | 'button' | 'avatar';

export const skeletonTokens = {
  heights: { line: 14, block: 96, row: 44, button: 44, avatar: 40 },
  radius: 6,
  gap: 12,
  gateRow: 176,
  gateViewport: 0.4,
  colors: {
    dark: publicationGateColors.dark.border,
    light: publicationGateColors.light.border,
  },
} as const;

/** Reserve the same gate scroll area before and after evidence arrives. */
export function gateClaimsHeight(rows: number, viewportHeight: number): number {
  return Math.min(
    Math.max(0, rows) * skeletonTokens.gateRow,
    viewportHeight * skeletonTokens.gateViewport,
  );
}
