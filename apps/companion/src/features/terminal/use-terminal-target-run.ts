import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Methods, type Run, type RunForSlotResult, type RunGetResult } from '@farmslot/protocol';
import { resourceQuery, type ResourceQueryState } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { currentFarmConnection } from '../../lib/connection-authority';
import { getResourceCache, getResourceWorkspaceKey } from '../../lib/resource-cache';
import { targetWarningForRun } from '../../lib/terminal-target';
import { useConnectionStore } from '../../store/connection';

type TerminalTargetResult = RunGetResult | RunForSlotResult;
interface TargetReadFailure {
  key: string;
  message: string;
  observation: ResourceQueryState<TerminalTargetResult>;
}

/** Resolve the run independently of either transport, including direct native reviewer links. */
export function useTerminalTargetRun(slotId: string, runId?: string) {
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const query = useMemo(
    () =>
      runId
        ? resourceQuery<TerminalTargetResult>(Methods.RUN_GET, { runId })
        : slotId
          ? resourceQuery<TerminalTargetResult>(Methods.RUN_FOR_SLOT, { slotId })
          : undefined,
    [runId, slotId],
  );
  const observation = useResourceQuery(query);
  const run = observation.data?.run ?? null;
  const workspaceKey = getResourceWorkspaceKey();
  const key = JSON.stringify([workspaceKey, slotId, runId, status, client?.connectionGeneration]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [failure, setFailure] = useState<TargetReadFailure>();
  const request = useRef(0);
  const applyRun = useCallback(
    (value: Run | null): string | null => (value ? targetWarningForRun(value, slotId) : null),
    [slotId],
  );
  const warning =
    failure?.key === key && failure.observation === observation
      ? failure.message
      : observation.error
        ? `Could not verify run target: ${observation.error.message}`
        : applyRun(run);
  const refresh = useCallback(async (): Promise<{ warning: string | null; run: Run | null }> => {
    const sequence = ++request.current;
    if (!client || !query) return { warning: null, run: null };
    const cache = getResourceCache();
    const current = currentFarmConnection(client, useConnectionStore.getState);
    const ownsRequest = () =>
      current() &&
      request.current === sequence &&
      currentKey.current === key &&
      cache === getResourceCache() &&
      workspaceKey === getResourceWorkspaceKey();
    try {
      if (!cache) throw new Error('The current run target store is unavailable.');
      await cache.retry(query);
      if (!ownsRequest()) return { warning: null, run: null };
      const observed = cache.read(query);
      if (observed.status !== 'ready' || !observed.data)
        throw new Error(observed.error?.message ?? 'Wait for a current run target before acting.');
      setFailure(undefined);
      return { warning: applyRun(observed.data.run), run: observed.data.run };
    } catch (error) {
      const message = `Could not verify run target: ${error instanceof Error ? error.message : String(error)}`;
      if (ownsRequest())
        setFailure({ key, message, observation: cache?.read(query) ?? observation });
      return { warning: message, run: null };
    }
  }, [applyRun, client, query, key, workspaceKey, observation]);
  useEffect(() => {
    return () => {
      request.current++;
    };
  }, [client, key]);
  return { run, warning, applyRun, refresh };
}
