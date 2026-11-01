/** Runner context comes from the shared worker observation, never pane text. */
import { useIsFocused } from 'expo-router';
import { useEffect, useMemo } from 'react';

import { Methods, type TmuxWorkerListResult, tmuxWorkerRefsMatch } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { heldDataUsable } from '../lib/resource-read-status';
import {
  paneRunnerContext,
  type TerminalRunnerContext,
  type TerminalRunnerPane,
} from '../lib/terminal-controls';
import { useConnectionStore } from '../store/connection';
import { useHeldConnection } from '../store/held-connection';
import { useTerminalPrefsStore } from '../store/terminal-prefs';

import { useResourceQuery } from './useResourceQuery';

export interface PaneRunnerContextState {
  context: TerminalRunnerContext;
}

export function usePaneRunnerContext(pane: TerminalRunnerPane | null): PaneRunnerContextState {
  const focused = useIsFocused();
  const client = useConnectionStore((s) => s.client);
  const transport = useConnectionStore(
    (s) => s.status === 'connected' && s.client?.connectionState === 'connected',
  );
  // Connected, or within a short reconnect: held inventory keeps the runner keys.
  const connected = useHeldConnection();
  const forgetClosedPanes = useTerminalPrefsStore((s) => s.forgetClosedPanes);
  const nodeId = pane?.nodeId ?? null;
  const target = pane?.target ?? null;
  const query = useMemo(
    () =>
      nodeId && target
        ? resourceQuery<TmuxWorkerListResult>(Methods.TMUX_WORKER_LIST, { machine: nodeId })
        : undefined,
    [nodeId, target],
  );
  const observation = useResourceQuery(focused ? query : undefined);
  // A reread in flight keeps the held inventory usable; only saved or missing data gates
  // runner keys. A gated pane falls back to no runner, which the runner chip already shows.
  const ready = Boolean(client && query && heldDataUsable(observation, connected));
  const summary = ready
    ? (observation.data?.workers.find((worker) =>
        tmuxWorkerRefsMatch(worker.ref, { nodeId: nodeId!, target: target! }),
      ) ?? null)
    : null;
  // Forgetting saved pane preferences is destructive, so only a current read may prune them:
  // held inventory can miss a pane that another read already shows.
  const current = Boolean(client && transport && observation.status === 'ready');
  useEffect(() => {
    if (!current || !nodeId) return;
    const node = observation.data?.nodes.find((entry) => entry.nodeId === nodeId);
    if (node?.ok && !node.hiddenWorkers)
      forgetClosedPanes(
        nodeId,
        node.workers.map((worker) => worker.ref.target),
      );
  }, [current, nodeId, observation.data, forgetClosedPanes]);

  const context = useMemo(
    () => paneRunnerContext(nodeId && target ? { nodeId, target } : null, summary),
    [nodeId, summary, target],
  );
  return { context };
}
