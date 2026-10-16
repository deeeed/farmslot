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
    proven: '#74e3a0',
    provenSurface: '#133c29',
    verified: '#5cddd2',
    verifiedSurface: '#103b3b',
    checked: '#a4caff',
    checkedSurface: '#193760',
    issue: '#ffb0b0',
    issueSurface: '#55252d',
    pending: '#ffda85',
    pendingSurface: '#473513',
    untestable: '#d0d2dd',
    untestableSurface: '#343643',
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
    proven: '#176338',
    provenSurface: '#e0f5e7',
    verified: '#075f60',
    verifiedSurface: '#dcf5f1',
    checked: '#174f91',
    checkedSurface: '#e4efff',
    issue: '#9c242b',
    issueSurface: '#ffe7e8',
    pending: '#795000',
    pendingSurface: '#fff0c9',
    untestable: '#4a4f60',
    untestableSurface: '#e9eaf0',
  },
} as const;

/** Namespaced tokens for the shared web gate and evidence controls. */
export function publicationGateCssVariables(mode: 'dark' | 'light', prefix = 'gate'): string {
  return Object.entries(publicationGateColors[mode])
    .map(([name, value]) => `--${prefix}-${name}: ${value};`)
    .join('');
}
