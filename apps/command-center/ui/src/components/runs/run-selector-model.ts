import type { RunStatus } from '@farmslot/protocol';
import { isTerminalRunStatus } from '@farmslot/protocol';

/** Runs that can seed a comparison-lane sibling fork in dispatch. */
export function canLaunchComparisonSibling(status: RunStatus): boolean {
  return isTerminalRunStatus(status) || status === 'blocked' || status === 'human-gating';
}
