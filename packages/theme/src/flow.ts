import { colors } from './palette';

export const FLOW_COLORS: Record<string, string> = {
  'fix-bug': colors.statusFail,
  'review-pr': '#06b6d4',
  dev: colors.accent,
  'pr-complete': '#8b5cf6',
  'merge-main': '#f59e0b',
};

export const FLOW_LABELS: Record<string, string> = {
  'fix-bug': 'BUG',
  'review-pr': 'REV',
  dev: 'DEV',
  'pr-complete': 'PRC',
  'merge-main': 'MRG',
};

export function flowColor(flow: string): string {
  return FLOW_COLORS[flow] ?? colors.textMuted;
}

export function flowLabel(flow: string): string {
  return FLOW_LABELS[flow] ?? '???';
}
