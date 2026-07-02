import type { Run, RunStatus } from '@farmslot/protocol';
import { isTerminalRunStatus } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import { flowColor } from './run-utils.js';

export function runBadgeColorFromRun(run: Pick<Run, 'flowType' | 'lane'>): string {
  return run.lane === 'comparison' ? colors.accent : flowColor(run.flowType);
}

/** Runs that can seed a comparison-lane sibling fork in dispatch. */
export function canLaunchComparisonSibling(status: RunStatus): boolean {
  return isTerminalRunStatus(status) || status === 'blocked' || status === 'human-gating';
}
