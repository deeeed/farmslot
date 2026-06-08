import type { SlotRunHistoryEntry } from '@farmslot/protocol';

import type { VisualArtifactPair } from '../../lib/artifact-url';
import type { DecisionPresentation } from '../../lib/decision-presentation';
import { colors } from '../../lib/theme';
import { workspaceRouteContextParams } from '../../lib/workspace-navigation';

export const RUN_STATUS_COLORS: Record<string, string> = {
  done: colors.statusOk,
  failed: colors.statusFail,
  cancelled: colors.statusWarn,
  monitoring: colors.lifecycleWorking,
  preparing: colors.lifecycleDispatching,
  dispatching: colors.lifecycleDispatching,
  'writing-task': colors.accent,
  grading: colors.accent,
  'slot-finding': colors.accent,
  paused: colors.statusWarn,
};

export const TONE_COLORS: Record<DecisionPresentation['tone'], string> = {
  ok: colors.statusOk,
  warn: colors.statusWarn,
  fail: colors.statusFail,
  info: colors.accent,
};

export type SlotHistoryWorkspaceEntry = SlotRunHistoryEntry & {
  prNumber?: number | null;
  links?: Array<{ label?: string | null; url?: string | null }> | null;
};

export interface HistoryRecipeEvidenceSummary {
  artifactCount: number;
  pairCount: number;
  recipeRunId: string | null;
  artifactPath: string | null;
  primaryPair: VisualArtifactPair | null;
}

export interface HistoryRunVisualEvidenceSummary {
  pairCount: number;
  primaryPair: VisualArtifactPair | null;
}

export type SlotWorkspaceRouteFocus = ReturnType<typeof workspaceRouteContextParams>['workspace'];

export function slotGateFocusForWorkspace(
  workspace: SlotWorkspaceRouteFocus,
): 'ready' | 'review' | 'no-change' | null {
  if (workspace === 'ready') return 'ready';
  if (workspace === 'review') return 'review';
  return null;
}
