import type { Run } from '@farmslot/protocol';

export type SlotViewLinkedRunSource = 'cache' | 'rpc';

const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'cancelled']);

export function isSlotViewTerminalRunStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL_RUN_STATUSES.has(status);
}

/** Pick which run slot-view should treat as linked after cache + RPC hydration. */
export function selectSlotViewLinkedRun(params: {
  requestedRunId: string | null;
  slotBoundRunId: string | null;
  cachedRun: Run | null;
  rpcRun: Run | null;
}): Run | null {
  const authoritativeBoundRun =
    params.slotBoundRunId && params.rpcRun?.id === params.slotBoundRunId ? params.rpcRun : null;
  if (authoritativeBoundRun) return authoritativeBoundRun;
  if (params.rpcRun?.id === params.requestedRunId) return params.rpcRun;
  const keepRequestedRun = Boolean(
    params.requestedRunId && params.cachedRun?.id === params.requestedRunId,
  );
  if (keepRequestedRun) return params.cachedRun;
  return params.rpcRun;
}

export function shouldPreserveSlotViewCachedNullRun(params: {
  source: SlotViewLinkedRunSource;
  previousRunId: string | null;
}): boolean {
  return params.source === 'cache' && params.previousRunId !== null;
}

export function slotViewLinkedRunTransition(params: {
  previousRunId: string | null;
  nextRunId: string;
  prevRunStatus: string | null;
  nextRunStatus: string;
}): {
  reachedTerminal: boolean;
  runChanged: boolean;
  shouldClearAgentContext: boolean;
  shouldResetUnavailableContexts: boolean;
  shouldRefreshMonitoringProgress: boolean;
} {
  const reachedTerminal =
    isSlotViewTerminalRunStatus(params.nextRunStatus) &&
    Boolean(params.prevRunStatus) &&
    !isSlotViewTerminalRunStatus(params.prevRunStatus);
  const runChanged = Boolean(params.previousRunId && params.previousRunId !== params.nextRunId);

  return {
    reachedTerminal,
    runChanged,
    shouldClearAgentContext: reachedTerminal || runChanged,
    shouldResetUnavailableContexts: runChanged,
    shouldRefreshMonitoringProgress:
      params.nextRunStatus === 'monitoring' && params.prevRunStatus !== 'monitoring',
  };
}
