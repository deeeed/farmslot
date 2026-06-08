import type { DecisionPresentation } from '../../lib/decision-presentation';
import { colors } from '../../lib/theme';

export const TONE_COLORS: Record<DecisionPresentation['tone'], string> = {
  ok: colors.statusOk,
  warn: colors.statusWarn,
  fail: colors.statusFail,
  info: colors.accent,
};
