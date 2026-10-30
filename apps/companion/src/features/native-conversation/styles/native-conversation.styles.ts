import { StyleSheet } from 'react-native';

import { colors, fonts, radii, spacing } from '../../../lib/theme';

export const nativeStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  timeline: { flex: 1 },
  // Overlays the bottom of the timeline, so it never moves the conversation or the composer.
  jumpLatest: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: spacing.md,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: 22,
    backgroundColor: colors.bgCardHover,
    justifyContent: 'center',
  },
  content: { padding: spacing.lg, gap: spacing.md },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  heading: { color: colors.textPrimary, fontSize: fonts.sizeLg, fontWeight: '800' },
  text: { color: colors.textPrimary, fontSize: fonts.sizeSm, lineHeight: 21 },
  muted: { color: colors.textMuted, fontSize: fonts.sizeXs, lineHeight: 18 },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm, lineHeight: 20 },
  card: {
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
  },
  user: { borderLeftWidth: 3, borderLeftColor: colors.accent },
  code: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  detail: { maxHeight: 250 },
  button: {
    backgroundColor: colors.bgCardHover,
    borderRadius: radii.md,
    padding: spacing.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  buttonText: { color: colors.accent, fontWeight: '700', fontSize: fonts.sizeSm },
  disabled: { opacity: 0.45 },
  messageToggle: { minHeight: 44, justifyContent: 'center' },
  input: {
    color: colors.textPrimary,
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    minHeight: 48,
    maxHeight: 160,
  },
  composer: {
    padding: spacing.md,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderColor: colors.bgCardHover,
  },
  selected: { borderColor: colors.accent, borderWidth: 1 },
});
