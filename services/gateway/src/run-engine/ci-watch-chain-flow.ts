import type { FlowType } from '@farmslot/protocol';

/**
 * The child flow a CI-watch dispatch action starts, or null for any other action.
 * A leaf module, so the CI monitor's state can ask "is this a dispatch?" without
 * loading the runner registry.
 */
export function resolveCIWatchChainFlowType(dispatchAction?: string | null): FlowType | null {
  if (dispatchAction === 'dispatch-update-branch') return 'update-branch';
  if (dispatchAction === 'dispatch-pr-complete') return 'pr-complete';
  return null;
}
