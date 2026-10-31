/** Runner context comes from the shared worker observation, never pane text. */
import { useIsFocused } from 'expo-router';
import { useEffect, useMemo } from 'react';

import { Methods, type TmuxWorkerListResult, tmuxWorkerRefsMatch } from '@farmslot/protocol';
import { canActOn, heldDataIsSaved, resourceQuery } from '@farmslot/protocol/client-cache';

import { visibleReadError } from '../lib/resource-read-status';
import {
  paneRunnerContext,
  type TerminalRunnerContext,
  type TerminalRunnerPane,
} from '../lib/terminal-controls';
import { useConnectionStore } from '../store/connection';
import { useTerminalPrefsStore } from '../store/terminal-prefs';

import { useResourceQuery } from './useResourceQuery';

export interface PaneRunnerContextState {
  context: TerminalRunnerContext;
  error: string | null;
}

export function usePaneRunnerContext(pane: TerminalRunnerPane | null): PaneRunnerContextState {
  const focused = useIsFocused();
  const client = useConnectionStore((s) => s.client);
  const connected = useConnectionStore(
    (s) => s.status === 'connected' && s.client?.connectionState === 'connected',
  );
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
  // runner keys, and loading or a reread never shows an error.
  const ready = Boolean(client && query && canActOn(observation, connected));
  const saved = heldDataIsSaved(observation, connected);
  const summary = ready
    ? (observation.data?.workers.find((worker) =>
        tmuxWorkerRefsMatch(worker.ref, { nodeId: nodeId!, target: target! }),
      ) ?? null)
    : null;
  const error = !query
    ? null
    : (visibleReadError(observation, saved)?.message ??
      (observation.status === 'unsupported'
        ? 'Worker observations are unsupported.'
        : saved
          ? 'Runner keys wait for current worker inventory.'
          : null));
  useEffect(() => {
    if (!ready || !nodeId) return;
    const node = observation.data?.nodes.find((entry) => entry.nodeId === nodeId);
    if (node?.ok && !node.hiddenWorkers)
      forgetClosedPanes(
        nodeId,
        node.workers.map((worker) => worker.ref.target),
      );
  }, [ready, nodeId, observation.data, forgetClosedPanes]);

  const context = useMemo(
    () => paneRunnerContext(nodeId && target ? { nodeId, target } : null, summary),
    [nodeId, summary, target],
  );
  return { context, error };
}
