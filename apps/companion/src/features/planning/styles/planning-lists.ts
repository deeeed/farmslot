import { StyleSheet } from 'react-native';

import { colors, floatingCopilotGutter, fonts, radii, spacing } from '../../../lib/theme';

export const planningListStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
    paddingRight: floatingCopilotGutter,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgCard,
  },
  title: { color: colors.textPrimary, fontSize: fonts.sizeXl, fontWeight: '900' },
  button: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
  },
  buttonText: { color: colors.accent, fontSize: fonts.sizeSm, fontWeight: '700' },
  retry: { alignSelf: 'flex-start', marginHorizontal: spacing.lg, marginBottom: spacing.md },
  list: { gap: spacing.md, padding: spacing.lg },
  card: {
    padding: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
  },
  heading: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: fonts.sizeSm },
  ref: { color: colors.textSecondary, fontFamily: fonts.mono, fontSize: fonts.sizeXs },
  status: { color: colors.accent, fontSize: fonts.sizeSm },
  details: {
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.bgCardHover,
    paddingTop: spacing.md,
  },
  node: { gap: spacing.sm },
  empty: { color: colors.textMuted, padding: spacing.lg, fontSize: fonts.sizeSm },
});
