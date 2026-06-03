import { colors } from './palette';

export const LIFECYCLE_COLORS: Record<string, string> = {
  ready: colors.statusOk,
  busy: '#f59e0b',
  held: '#a78bfa',
  manual: '#06b6d4',
  disabled: '#333344',
};

export function lifecycleColor(state: string): string {
  return LIFECYCLE_COLORS[state] ?? colors.statusUnknown;
}
