import { colors } from './palette';

/** Accessible decision surfaces in either system appearance. */
export const publicationGateColors = {
  dark: {
    background: colors.bgCard,
    surface: colors.bgSurface,
    text: colors.textPrimary,
    secondary: '#b6b6ca',
    border: '#42425a',
    accent: colors.accentHover,
    onAccent: '#0a0a0f',
    warning: colors.statusWarn,
  },
  light: {
    background: '#ffffff',
    surface: '#f3f4f8',
    text: '#20212f',
    secondary: '#50546a',
    border: '#c4c7d3',
    accent: '#4338ca',
    onAccent: '#ffffff',
    warning: '#785000',
  },
} as const;
