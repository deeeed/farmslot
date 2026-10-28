import { StyleSheet } from 'react-native';

import { colors } from '../../lib/theme';

export const quickActionsStyles = StyleSheet.create({
  floating: { position: 'absolute', zIndex: 50, elevation: 8 },
  button: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#0008' },
  menu: {
    backgroundColor: colors.bgSurface,
    padding: 20,
    gap: 8,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  label: { color: colors.textPrimary, fontSize: 16 },
  disabled: { opacity: 0.45 },
  reason: { color: colors.textSecondary, fontSize: 13, paddingHorizontal: 12 },
  feedback: { color: colors.textPrimary, fontSize: 14, padding: 12 },
});
