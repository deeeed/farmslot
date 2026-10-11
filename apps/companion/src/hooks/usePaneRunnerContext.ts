/**
 * Reads what the Gateway knows about the runner in one tmux pane: the linked run's
 * runner, which it sets only on the pane that runs that worker, and the runners the
 * pane's process matches. The terminal key bar picks its runner row from this and
 * never reads pane text. Re-read every 15 s so a runner started in an open pane, or
 * a run linked later, shows up without reopening the terminal.
 */
import { useEffect, useMemo, useState } from 'react';

import {
  Methods,
  type TmuxWorkerListResult,
  tmuxWorkerRefsMatch,
  type TmuxWorkerSummary,
} from '@farmslot/protocol';

import { isGatewayBackgroundPauseError } from '../lib/recoverable-errors';
import {
  paneRunnerContext,
  type TerminalRunnerContext,
  type TerminalRunnerPane,
} from '../lib/terminal-controls';
import { useConnectionStore } from '../store/connection';
import { useTerminalPrefsStore } from '../store/terminal-prefs';

const REFRESH_MS = 15_000;

type PaneRunnerSummary = Pick<TmuxWorkerSummary, 'linkedRunner' | 'processRunnerIds'>;

export interface PaneRunnerContextState {
  context: TerminalRunnerContext;
  error: string | null;
}

export function usePaneRunnerContext(pane: TerminalRunnerPane | null): PaneRunnerContextState {
  const client = useConnectionStore((s) => s.client);
  const connected = useConnectionStore((s) => s.status === 'connected');
  const forgetClosedPanes = useTerminalPrefsStore((s) => s.forgetClosedPanes);
  const [summary, setSummary] = useState<PaneRunnerSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nodeId = pane?.nodeId ?? null;
  const target = pane?.target ?? null;

  useEffect(() => {
    setSummary(null);
    setError(null);
    if (!client || !connected || !nodeId || !target) return;
    let disposed = false;
    const load = async () => {
      const list = await client.request<TmuxWorkerListResult>(
        Methods.TMUX_WORKER_LIST,
        { includeDisconnected: false, machine: nodeId },
        10_000,
      );
      if (disposed) return;
      const node = list.nodes.find((entry) => entry.nodeId === nodeId);
      // Only a node that answered, with no panes hidden by the pool's tmuxWorkers rules, lists
      // all of its panes.
      if (node?.ok && !node.hiddenWorkers) {
        forgetClosedPanes(
          nodeId,
          node.workers.map((worker) => worker.ref.target),
        );
      }
      setSummary(
        list.workers.find((worker) => tmuxWorkerRefsMatch(worker.ref, { nodeId, target })) ?? null,
      );
      setError(null);
    };
    const refresh = () =>
      load().catch((err: Error) => {
        // A disposed key bar has no row left to report into.
        if (disposed) return;
        if (isGatewayBackgroundPauseError(err)) {
          // Backgrounding pauses gateway requests; the last reading stays until the next refresh.
          console.warn(`Runner keys refresh paused: ${err.message}`);
          return;
        }
        setError(`Runner keys unavailable: ${err.message}`);
      });
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, connected, forgetClosedPanes, nodeId, target]);

  const context = useMemo(
    () => paneRunnerContext(nodeId && target ? { nodeId, target } : null, summary),
    [nodeId, summary, target],
  );
  return { context, error };
}
