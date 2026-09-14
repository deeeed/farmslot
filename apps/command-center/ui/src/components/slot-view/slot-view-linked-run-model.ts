import { isTerminalRunStatus, type Run, type RunStatus } from '@farmslot/protocol';

import { runHasTrimmedDecisions } from '../runs/run-detail-model.js';

import { deriveSlotViewAgentContexts } from './slot-view-agent-contexts.js';

export type SlotViewLinkedRunSource = 'cache' | 'rpc';

export function isSlotViewTerminalRunStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && isTerminalRunStatus(status as RunStatus);
}

/** Explicit native URLs must resolve exactly, without the legacy role fallback. */
export function isSlotViewContextPinUnresolved(params: {
  run: Run | null;
  requestedRunId: string | null;
  requestedContextId: string | null;
  slotId?: string;
}): boolean {
  if (!params.requestedRunId || !params.requestedContextId) return false;
  const run = params.run;
  if (!run) return true;
  // Terminal pins retain their existing slot-owner and role-following semantics.
  if (run.transport !== 'native') return false;
  const context = run.agentContexts?.find((item) => item.id === params.requestedContextId);
  const native = deriveSlotViewAgentContexts({ linkedRun: run, slot: null }).find(
    (item) => item.id === params.requestedContextId,
  );
  return !(
    run.id === params.requestedRunId &&
    params.slotId &&
    run.slotId === params.slotId &&
    context?.slotId === params.slotId &&
    context.runId === run.id &&
    native?.nativeSession
  );
}

/** Pick which run slot-view should treat as linked after cache + RPC hydration. */
export function selectSlotViewLinkedRun(params: {
  requestedRunId: string | null;
  slotBoundRunId: string | null;
  cachedRun: Run | null;
  rpcRun: Run | null;
  requestedContextId?: string | null;
  slotId?: string;
}): Run | null {
  if (params.requestedRunId && params.requestedContextId) {
    const requested = [params.rpcRun, params.cachedRun].find(
      (run) => run?.id === params.requestedRunId,
    );
    if (!requested) return null;
    if (requested.transport === 'native') {
      return isSlotViewContextPinUnresolved({
        run: requested,
        requestedRunId: params.requestedRunId,
        requestedContextId: params.requestedContextId,
        slotId: params.slotId,
      })
        ? null
        : requested;
    }
  }
  const authoritativeBoundRun =
    params.slotBoundRunId && params.rpcRun?.id === params.slotBoundRunId ? params.rpcRun : null;
  if (authoritativeBoundRun) return authoritativeBoundRun;
  if (params.requestedRunId) {
    if (params.rpcRun?.id === params.requestedRunId) return params.rpcRun;
    if (params.cachedRun?.id === params.requestedRunId) return params.cachedRun;
    // URL-pinned load-run must not fall back to slot-history when hydration is still in flight.
    return null;
  }
  return params.rpcRun;
}

export function shouldPreserveSlotViewCachedNullRun(params: {
  source: SlotViewLinkedRunSource;
  previousRunId: string | null;
  contextPinUnresolved?: boolean;
}): boolean {
  return !params.contextPinUnresolved && params.source === 'cache' && params.previousRunId !== null;
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

/**
 * A pinned run must come from run.get when the state cache has no row for it
 * or only a run.list row with trimmed decision payloads: the slot view renders
 * the recipe and review panels from those payloads.
 */
export function slotViewNeedsDirectRunFetch(
  requestedRunId: string | null,
  cachedRun: Pick<Run, 'decisions'> | null,
  requestedContextId: string | null = null,
): boolean {
  if (!requestedRunId) return false;
  return Boolean(requestedContextId) || !cachedRun || runHasTrimmedDecisions(cachedRun);
}
