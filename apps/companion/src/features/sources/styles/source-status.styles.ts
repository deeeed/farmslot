import { StyleSheet } from 'react-native';

import { colors, fonts, radii, spacing } from '../../../lib/theme';

export const sourceStyles = StyleSheet.create({
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
  button: { padding: spacing.sm, backgroundColor: colors.bgCardHover, borderRadius: radii.sm },
  disabled: { opacity: 0.45 },
  error: { color: colors.statusFail, marginVertical: spacing.sm },
  placeholder: { color: colors.textMuted },
});
