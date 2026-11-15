import { StyleSheet } from 'react-native';

import { colors, fonts, spacing } from '../../../lib/theme';

export const nativeFileStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    // The iOS header keeps touches a little below its edge; the controls sit clear of it.
    paddingTop: spacing.xxl,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderColor: colors.bgCardHover,
  },
  path: { flex: 1, color: colors.textSecondary, fontSize: fonts.sizeXs, fontFamily: 'monospace' },
  toggle: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md },
  toggleText: { color: colors.accent, fontWeight: '700', fontSize: fonts.sizeSm },
  muted: { color: colors.textMuted, padding: spacing.lg },
  error: { color: colors.statusFail, padding: spacing.lg },
});
