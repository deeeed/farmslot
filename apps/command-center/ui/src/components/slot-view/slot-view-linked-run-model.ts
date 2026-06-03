export type SlotViewLinkedRunSource = 'cache' | 'rpc';

const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'cancelled']);

export function isSlotViewTerminalRunStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL_RUN_STATUSES.has(status);
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
