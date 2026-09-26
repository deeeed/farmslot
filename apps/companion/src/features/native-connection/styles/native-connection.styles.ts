import { StyleSheet } from 'react-native';

import { colors, fonts, radii, spacing } from '../../../lib/theme';

export const connectionStyles = StyleSheet.create({
  page: {
    flex: 1,
  },
  lead: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 20,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    padding: spacing.lg,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: fonts.sizeMd,
    fontWeight: '800',
    textAlign: 'center',
  },
  toggle: {
    paddingVertical: spacing.sm,
  },
  toggleText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
  },
});
