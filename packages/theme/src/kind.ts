import { colors } from './palette';

export const KIND_COLORS: Record<string, string> = {
  review: '#06b6d4',
  ready: colors.statusOk,
  'no-change': colors.textMuted,
  retrospective: colors.accent,
  collision: colors.statusFail,
  slot_picker: '#f59e0b',
  branch_affinity_nudge: '#8b5cf6',
  improvement: '#f59e0b',
};
