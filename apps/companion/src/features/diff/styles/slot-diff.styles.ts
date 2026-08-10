import { StyleSheet } from 'react-native';

import { colors, fonts, radii, spacing } from '../../../lib/theme';
export const slotDiffStyles = StyleSheet.create({
  header: {
    backgroundColor: colors.bgSurface,
    borderBottomColor: colors.bgCard,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  backButton: {
    justifyContent: 'center',
    paddingRight: spacing.sm,
  },
  backButtonText: {
    color: colors.accent,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
  headerTitle: { flex: 1 },
  eyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXl,
    fontWeight: '900',
    marginTop: spacing.xs,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  comparePreviewPanel: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '24',
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing.lg,
    padding: spacing.xs,
  },
  contextCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.lg,
    padding: spacing.sm,
  },
  contextHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  contextTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  contextEyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  contextTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  contextPill: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  contextPillText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  contextRail: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  contextMetric: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    borderColor: colors.bgCardHover,
    borderWidth: 1,
    minWidth: 112,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  contextMetricDisabled: {
    opacity: 0.45,
  },
  contextMetricLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  contextMetricValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  errorText: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
    marginBottom: spacing.md,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
});
