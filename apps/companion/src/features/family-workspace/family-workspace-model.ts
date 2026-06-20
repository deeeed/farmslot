import type { VisualArtifactPair } from '../../lib/artifact-url';
import type { DecisionPresentation } from '../../lib/decision-presentation';
import type { FamilyEvidenceFilter } from '../../lib/family-evidence';
import { colors } from '../../lib/theme';

export const STATUS_COLORS: Record<string, string> = {
  done: colors.statusOk,
  failed: colors.statusFail,
  cancelled: colors.statusWarn,
  monitoring: colors.lifecycleWorking,
  preparing: colors.lifecycleDispatching,
  dispatching: colors.lifecycleDispatching,
  paused: colors.statusWarn,
};

export const TONE_COLORS: Record<DecisionPresentation['tone'], string> = {
  ok: colors.statusOk,
  warn: colors.statusWarn,
  fail: colors.statusFail,
  info: colors.accent,
};

export const EVIDENCE_FILTERS: Array<{ id: FamilyEvidenceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
  { id: 'videos', label: 'Videos' },
  { id: 'review', label: 'Review' },
  { id: 'diffs', label: 'Diffs' },
  { id: 'recipes', label: 'Recipes' },
  { id: 'setup', label: 'Setup' },
];

export interface FamilyRecipeEvidenceSummary {
  artifactCount: number;
  pairCount: number;
  recipeRunId: string | null;
  artifactPath: string | null;
  primaryPair: VisualArtifactPair | null;
}

export type FamilySectionKey = 'focus' | 'compare' | 'ledger' | 'retros' | 'evidence' | 'runs';

export const FAMILY_SECTION_KEYS: readonly FamilySectionKey[] = [
  'focus',
  'compare',
  'ledger',
  'retros',
  'evidence',
  'runs',
];

export function normalizeFamilySectionParam(
  value: string | string[] | undefined,
): FamilySectionKey | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  return FAMILY_SECTION_KEYS.includes(raw as FamilySectionKey) ? (raw as FamilySectionKey) : null;
}
