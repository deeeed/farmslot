import { StyleSheet } from 'react-native';

import { colors, fonts, radii, spacing } from '../../../lib/theme';

export const pairingScannerStyles = StyleSheet.create({
  container: {
    backgroundColor: '#000',
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    backgroundColor: 'rgba(0,0,0,0.72)',
    bottom: 0,
    left: 0,
    padding: spacing.xl,
    position: 'absolute',
    right: 0,
  },
  title: {
    color: '#fff',
    fontSize: fonts.sizeLg,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  help: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },
  progress: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  cancel: {
    backgroundColor: colors.bgCardHover,
    borderRadius: radii.md,
    marginTop: spacing.xl,
    padding: spacing.md,
  },
  cancelText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
});
