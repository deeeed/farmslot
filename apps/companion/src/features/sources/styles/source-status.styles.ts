import { StyleSheet } from 'react-native';

import { colors, fonts, radii, spacing } from '../../../lib/theme';

export const sourceStyles = StyleSheet.create({
  disclosureSlot: { height: 44, flexShrink: 0 },
  disclosure: {
    height: 44,
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  disclosureSummary: { flex: 1, color: colors.textSecondary, fontSize: 11 },
  backdrop: { flex: 1, backgroundColor: '#0009', justifyContent: 'center', padding: spacing.lg },
  dialog: { maxHeight: '80%', backgroundColor: colors.bgCard, borderRadius: radii.md },
  close: {
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  panel: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  row: { paddingVertical: spacing.sm, borderTopWidth: 1, borderColor: colors.bgCardHover },
  facts: { color: colors.textPrimary, fontFamily: fonts.mono, fontSize: 11, marginVertical: 3 },
  input: {
    color: colors.textPrimary,
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginVertical: spacing.sm,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  button: {
    minHeight: 44,
    justifyContent: 'center',
    padding: spacing.sm,
    backgroundColor: colors.bgCardHover,
    borderRadius: radii.sm,
  },
  disabled: { opacity: 0.45 },
  error: { color: colors.statusFail, marginVertical: spacing.sm },
  placeholder: { color: colors.textMuted },
});
