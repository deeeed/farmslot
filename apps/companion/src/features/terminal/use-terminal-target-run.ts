import { useCallback, useEffect, useRef, useState } from 'react';

import { type Run, type RunForSlotResult, type RunGetResult } from '@farmslot/protocol';

import { currentFarmConnection } from '../../lib/connection-authority';
import { targetWarningForRun } from '../../lib/terminal-target';
import { useConnectionStore } from '../../store/connection';

/** Resolve the run independently of either transport, including direct native reviewer links. */
export function useTerminalTargetRun(slotId: string, runId?: string) {
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const [run, setRun] = useState<Run | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const request = useRef(0);
  const applyRun = useCallback(
    (value: Run | null): string | null => {
      setRun(value);
      const nextWarning = value ? targetWarningForRun(value, slotId) : null;
      setWarning(nextWarning);
      return nextWarning;
    },
    [slotId],
  );
  const refresh = useCallback(async (): Promise<{ warning: string | null; run: Run | null }> => {
    const sequence = ++request.current;
    if (!client || (!slotId && !runId)) {
      applyRun(null);
      return { warning: null, run: null };
    }
    const current = currentFarmConnection(client, useConnectionStore.getState);
    try {
      const result = runId
        ? await client.request<RunGetResult>('run.get', { runId })
        : await client.request<RunForSlotResult>('run.forSlot', { slotId });
      if (!current() || request.current !== sequence) return { warning: null, run: null };
      return { warning: applyRun(result.run), run: result.run };
    } catch (error) {
      const message = `Could not verify run target: ${error instanceof Error ? error.message : String(error)}`;
      if (current() && request.current === sequence) setWarning(message);
      return { warning: message, run: null };
    }
  }, [applyRun, client, runId, slotId]);
  useEffect(() => {
    applyRun(null);
    if (status === 'connected') void refresh();
    return () => {
      request.current++;
    };
  }, [applyRun, refresh, status]);
  return { run, warning, applyRun, refresh };
}
