import { StyleSheet } from 'react-native';

import { colors, fonts, radii, spacing } from '../../../lib/theme';

export const copilotStyles = StyleSheet.create({
  button: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.bgBase, fontSize: fonts.sizeSm, fontWeight: '900' },
  container: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxl },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm, marginTop: spacing.md },
  hint: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    lineHeight: 20,
    marginTop: spacing.sm,
    maxWidth: 420,
    textAlign: 'center',
  },
  icon: {
    alignItems: 'center',
    backgroundColor: colors.accent + '18',
    borderRadius: 999,
    height: 56,
    justifyContent: 'center',
    marginBottom: spacing.lg,
    width: 56,
  },
  pendingDraft: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.lg,
    padding: spacing.md,
    width: '100%',
  },
  pendingDraftLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  pendingDraftText: { color: colors.textSecondary, fontSize: fonts.sizeSm, lineHeight: 19 },
  status: { color: colors.textSecondary, fontSize: fonts.sizeMd, marginTop: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '900' },
});
