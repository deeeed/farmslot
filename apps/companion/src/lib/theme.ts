import { StyleSheet } from 'react-native';

import { colors as sharedColors, lifecycleColor as baseLifecycleColor } from '@farmslot/theme';

export const colors = {
  ...sharedColors,
  // Companion-only lifecycle phase tokens
  lifecycleReady: '#00ff88',
  lifecycleDispatching: '#6366f1',
  lifecycleWorking: '#f59e0b',
  lifecycleReleasing: '#8b5cf6',
  lifecycleReleased: '#666680',
  lifecycleCustom: '#06b6d4',
  lifecycleDisabled: '#333344',
} as const;

export const spacing = {
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
  xxxl: 32,
} as const;

export const radii = {
  sm: 3,
  md: 6,
  lg: 10,
} as const;

export const fonts = {
  mono: 'SF Mono',
  sizeXs: 10,
  sizeSm: 12,
  sizeMd: 14,
  sizeLg: 16,
  sizeXl: 20,
} as const;

export function lifecycleColor(state: string): string {
  const phaseMap: Record<string, string> = {
    preparing: colors.lifecycleDispatching,
    dispatching: colors.lifecycleDispatching,
    working: colors.lifecycleWorking,
    releasing: colors.lifecycleReleasing,
    released: colors.lifecycleReleased,
    'review-gate': colors.statusWarn,
    'ci-watch': '#a78bfa',
    custom: colors.lifecycleCustom,
  };
  return phaseMap[state] ?? baseLifecycleColor(state);
}

export const baseStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
  },
  surface: {
    backgroundColor: colors.bgSurface,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    padding: spacing.lg,
  },
  textPrimary: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
  },
  textSecondary: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
  },
  textMuted: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
  },
});
