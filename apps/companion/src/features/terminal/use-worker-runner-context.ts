import { useEffect, useMemo, useState } from 'react';

import {
  Methods,
  type Run,
  type RunGetResult,
  type TmuxWorkerListResult,
  type TmuxWorkerRef,
  tmuxWorkerRefsMatch,
  type TmuxWorkerSummary,
} from '@farmslot/protocol';

import type { GatewayClient } from '../../lib/gateway-client';
import {
  type TerminalRunnerContext,
  workerTerminalRunnerContext,
} from '../../lib/terminal-controls';

/** Reads the pane's process runner ids and linked run so the key bar can pick a runner row. */
export function useWorkerTerminalRunnerContext(
  client: GatewayClient | null,
  connected: boolean,
  worker: TmuxWorkerRef | null,
  onError: (message: string) => void,
): TerminalRunnerContext {
  const [pane, setPane] = useState<TmuxWorkerSummary | null>(null);
  const [linkedRun, setLinkedRun] = useState<Run | null>(null);

  useEffect(() => {
    setPane(null);
    setLinkedRun(null);
    if (!client || !connected || !worker) return;
    let disposed = false;
    const load = async () => {
      const list = await client.request<TmuxWorkerListResult>(
        Methods.TMUX_WORKER_LIST,
        { includeDisconnected: false, machine: worker.nodeId },
        10_000,
      );
      const summary = list.workers.find((entry) => tmuxWorkerRefsMatch(entry.ref, worker)) ?? null;
      if (disposed) return;
      setPane(summary);
      if (!summary?.linkedRunId) return;
      const { run } = await client.request<RunGetResult>(
        Methods.RUN_GET,
        { runId: summary.linkedRunId },
        10_000,
      );
      if (!disposed) setLinkedRun(run);
    };
    load().catch((err: Error) => {
      if (!disposed) onError(`Runner keys unavailable: ${err.message}`);
    });
    return () => {
      disposed = true;
    };
  }, [client, connected, onError, worker]);

  return useMemo(
    () => workerTerminalRunnerContext(worker, pane, linkedRun),
    [linkedRun, pane, worker],
  );
}
