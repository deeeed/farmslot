import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  Methods,
  type RunForSlotResult,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
} from '@farmslot/protocol';
import { canActOn, type ResourceQuery, resourceQuery } from '@farmslot/protocol/client-cache';

import { observeNativeSlotFrame, type SlotProofFrame } from '../../farmslot/run-collections-proof';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import { currentFarmConnection } from '../../lib/connection-authority';
import { getResourceCache, getResourceWorkspaceKey } from '../../lib/resource-cache';
import { assertNativeRunReady } from '../../lib/run-collections';
import {
  type CompanionTerminalTargetParams,
  shouldUseBareTerminalSessionForRun,
} from '../../lib/terminal-target';
import { useConnectionStore } from '../../store/connection';
import { useSlotNativeSession } from '../native-conversation/use-slot-native-session';

/** Keep the development probe current without changing its mounted subscription. */
export function useTerminalProof(frame: SlotProofFrame): void {
  const latest = useRef(frame);
  latest.current = frame;
  useEffect(() => {
    if (__DEV__ && frame.run?.id)
      return observeNativeSlotFrame('terminal', frame.run.id, () => latest.current);
  }, [frame.run?.id]);
}

/** Shared observations choose a target; terminal streams retain their existing owner. */
export function useTerminalRunContext(params: CompanionTerminalTargetParams) {
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const workspaceKey = getResourceWorkspaceKey();
  const slotQuery = useMemo(
    () =>
      !params.runId && params.slotId
        ? resourceQuery<RunForSlotResult>(Methods.RUN_FOR_SLOT, { slotId: params.slotId })
        : undefined,
    [params.runId, params.slotId],
  );
  const slot = useResourceQuery(slotQuery);
  const runId = params.runId ?? slot.data?.run?.id;
  const runQuery = useMemo(
    () => (runId ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId }) : undefined),
    [runId],
  );
  const run = useResourceQuery(runQuery);
  const recipeQuery = useMemo(
    () =>
      runId
        ? resourceQuery<RunRecipeRunsForRunResult>(Methods.RUN_RECIPE_RUNS_FOR_RUN, { runId })
        : undefined,
    [runId],
  );
  const recipes = useResourceQuery(recipeQuery);
  const targetRun = run.data?.run ?? null;
  const bareSession = shouldUseBareTerminalSessionForRun({
    requestedRunId: params.runId,
    requestedSlotId: params.slotId ?? '',
    run: targetRun,
  });
  const native = useSlotNativeSession(
    targetRun,
    params.slotId ?? '',
    params.contextId,
    params.runId ?? runId,
    { role: params.role, bareSession },
  );
  const target = native.terminalTarget;
  const scopeKey = JSON.stringify([
    workspaceKey,
    params.slotId,
    params.runId,
    runId,
    params.contextId,
    params.role,
    native.contextId,
    native.target?.binding.sessionId,
    native.target?.binding.leaseId,
    native.target?.binding.generation,
    target,
  ]);
  const scope = useRef(scopeKey);
  scope.current = scopeKey;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = useRef({ targetRun, slotQuery, runQuery });
  current.current = { targetRun, slotQuery, runQuery };
  const connected = status === 'connected' && client?.connectionState === 'connected';
  const ready =
    connected && (!slotQuery || slot.status === 'ready') && (!runId || run.status === 'ready');
  // Invalidation pauses commands without repeatedly tearing down the same stream.
  // A new target or connection must receive its own current read before subscribing.
  const admitted = useRef('');
  const connectionScope = JSON.stringify([scopeKey, client?.connectionGeneration]);
  if (ready) admitted.current = connectionScope;
  const streamReady = ready || admitted.current === connectionScope;
  // Keys go to the admitted stream. A reread in flight pauses commands, never typing;
  // saved data, a new target or a new connection still stop input.
  const inputReady =
    streamReady &&
    connected &&
    (!slotQuery || canActOn(slot, connected)) &&
    (!runId || canActOn(run, connected));

  const requireRun = useCallback(() => {
    const cache = getResourceCache();
    if (
      !client ||
      !currentFarmConnection(client, useConnectionStore.getState)() ||
      scope.current !== scopeKey ||
      workspaceKey !== getResourceWorkspaceKey()
    )
      throw new Error('Wait for the current terminal run before acting.');
    const selected = current.current;
    if (selected.slotQuery) {
      const state = cache?.read(selected.slotQuery);
      if (state?.status !== 'ready' || !state.data || state.data.run?.id !== selected.targetRun?.id)
        throw new Error('Wait for the current slot binding before acting.');
    }
    return runId ? assertNativeRunReady(runId, selected.targetRun ?? undefined) : null;
  }, [client, scopeKey, workspaceKey, runId]);

  const requireInput = useCallback(() => {
    const cache = getResourceCache();
    if (
      !client ||
      !currentFarmConnection(client, useConnectionStore.getState)() ||
      scope.current !== scopeKey ||
      workspaceKey !== getResourceWorkspaceKey() ||
      admitted.current !== JSON.stringify([scopeKey, client.connectionGeneration])
    )
      throw new Error('Wait for the current terminal run before typing.');
    const selected = current.current;
    if (selected.slotQuery) {
      const state = cache?.read(selected.slotQuery);
      if (!state || !canActOn(state, true) || state.data?.run?.id !== selected.targetRun?.id)
        throw new Error('Wait for the current slot binding before typing.');
    }
    if (selected.runQuery) {
      const state = cache?.read(selected.runQuery);
      if (!state || !canActOn(state, true) || state.data?.run.id !== runId)
        throw new Error('Wait for the current run before typing.');
    }
  }, [client, scopeKey, workspaceKey, runId]);

  const capture = useCallback(() => {
    const ownsView = () =>
      mounted.current && scope.current === scopeKey && workspaceKey === getResourceWorkspaceKey();
    const connected = client
      ? currentFarmConnection(client, useConnectionStore.getState)
      : () => false;
    return { ownsView, connectionCurrent: connected, current: () => ownsView() && connected() };
  }, [client, scopeKey, workspaceKey]);

  const retry = useCallback(async () => {
    const cache = getResourceCache();
    const queries: Array<ResourceQuery<unknown> | undefined> = [slotQuery, runQuery, recipeQuery];
    await Promise.all(
      queries
        .filter((query) => query && cache?.read(query).error)
        .map((query) => cache?.retry(query!)),
    );
  }, [slotQuery, runQuery, recipeQuery]);

  return {
    run,
    slot,
    recipes,
    targetRun,
    native,
    target,
    scopeKey,
    ready,
    streamReady,
    inputReady,
    requireRun,
    requireInput,
    capture,
    retry,
  };
}
