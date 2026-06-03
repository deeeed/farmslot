// Theme tokens as JS constants for Lit shadow DOM components.
// Import these in components and use in css`` tagged templates.
// Shared palette, runner/flow/lifecycle colors come from @farmslot/theme.

import { colors as sharedColors } from '@farmslot/theme';

export { lifecycleColor, runnerColor } from '@farmslot/theme';

export const colors = {
  ...sharedColors,
  // Command-center-only tokens
  bgSidebar: '#0d0d14',
  lifecycleReady: '#00ff88',
  lifecycleBusy: '#f59e0b',
  lifecycleHeld: '#a78bfa',
  lifecycleManual: '#06b6d4',
  lifecycleDisabled: '#333344',
} as const;

export const fonts = {
  mono: "'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
  sizeXs: '0.65rem',
  sizeSm: '0.75rem',
  sizeMd: '0.85rem',
  sizeLg: '1rem',
  sizeXl: '1.25rem',
} as const;

export const spacing = {
  xs: '2px',
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  xxl: '24px',
  xxxl: '32px',
} as const;

export const radii = {
  sm: '3px',
  md: '6px',
  lg: '10px',
} as const;

export const shadows = {
  card: '0 2px 8px rgba(0, 0, 0, 0.4)',
  elevated: '0 4px 16px rgba(0, 0, 0, 0.6)',
} as const;

export const layout = {
  sidebarWidth: '48px',
  sidebarWidthExpanded: '160px',
  summaryHeight: '36px',
} as const;

export function statusColor(status: string): string {
  const map: Record<string, string> = {
    ok: colors.statusOk,
    warn: colors.statusWarn,
    fail: colors.statusFail,
    unknown: colors.statusUnknown,
  };
  return map[status] ?? colors.statusUnknown;
}
