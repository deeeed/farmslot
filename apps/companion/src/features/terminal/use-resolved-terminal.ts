import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Methods,
  type RunForSlotResult,
  type RunGetResult,
  type TmuxWorkerListResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceCache } from '../../lib/resource-cache';
import { resolveTerminalWorkerRef, type TerminalSelector } from '../../lib/terminal-worker-ref';
import { useConnectionStore } from '../../store/connection';
import { useFleetStore } from '../../store/fleet';

/**
 * Resolves a slot or run link to its pane and runner target, creating a missing session once.
 * The pane and target keep their identity while their values hold, so a run refresh never
 * restarts the terminal's stream or drops its queued keys.
 */
export function useResolvedTerminal(selector: TerminalSelector) {
  const client = useConnectionStore((s) => s.client);
  const { slotId = '', runId, contextId, role } = selector;
  // A native run's slot can still open the slot's own shell.
  const [shell, setShell] = useState(Boolean(selector.shell));
  const stable = useMemo(
    () => ({ slotId, runId, contextId, role, shell }),
    [contextId, role, runId, shell, slotId],
  );
  const slotQuery = useMemo(
    () =>
      !runId && slotId
        ? resourceQuery<RunForSlotResult>(Methods.RUN_FOR_SLOT, { slotId })
        : undefined,
    [runId, slotId],
  );
  const runQuery = useMemo(
    () => (runId ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId }) : undefined),
    [runId],
  );
  // Not gated on focus: leaving the tab for Slot or Diff must not drop the open pane.
  const slotRun = useResourceQuery(slotQuery);
  const pinnedRun = useResourceQuery(runQuery);
  // Undefined while loading; a read that failed with nothing saved has no run to follow.
  const runRead = runQuery ? pinnedRun : slotQuery ? slotRun : undefined;
  const run = !runRead
    ? null
    : runRead.data
      ? runRead.data.run
      : runRead.error
        ? null
        : undefined;
  const slotMachine = useFleetStore(
    (s) => s.fleet?.slots.find((entry) => entry.slot === slotId)?.machine,
  );
  const first = resolveTerminalWorkerRef({
    selector: stable,
    run,
    slotMachine,
    inventory: undefined,
  });
  const machine = first.status === 'needs-inventory' ? first.machine : undefined;
  const inventoryQuery = useMemo(
    () =>
      machine
        ? resourceQuery<TmuxWorkerListResult>(Methods.TMUX_WORKER_LIST, { machine })
        : undefined,
    [machine],
  );
  const inventory = useResourceQuery(inventoryQuery);
  const resolved =
    first.status === 'needs-inventory'
      ? resolveTerminalWorkerRef({ selector: stable, run, slotMachine, inventory: inventory.data })
      : first;

  // A slot or worktree whose session is gone gets it created once (an existing session is
  // kept), then the inventory is read again. A pane the worker filter hides is said so only
  // when it is still missing after that.
  const [reinit, setReinit] = useState<string>('idle');
  const reinitKey = JSON.stringify([stable, machine]);
  const reinitFor = useRef('');
  useEffect(() => {
    if (resolved.status !== 'no-pane' || !client) return;
    if (reinitFor.current === reinitKey) return;
    reinitFor.current = reinitKey;
    setReinit('running');
    client
      .request(Methods.TERMINAL_REINIT, resolved.target, 15_000)
      .then(async () => {
        if (inventoryQuery) await getResourceCache()?.retry(inventoryQuery);
        setReinit('done');
      })
      .catch((error: Error) => setReinit(error.message));
  }, [client, inventoryQuery, reinitKey, resolved]);

  const resolvedWorker = resolved.status === 'ready' ? resolved.worker : null;
  const workerKey = resolvedWorker ? JSON.stringify(resolvedWorker) : '';
  const worker = useMemo(() => resolvedWorker, [workerKey]);
  const resolvedTarget = resolved.status === 'ready' ? resolved.target : null;
  const targetKey = JSON.stringify(resolvedTarget);
  const target = useMemo(() => resolvedTarget, [targetKey]);
  const reason =
    resolved.status === 'waiting' || resolved.status === 'unavailable'
      ? resolved.reason
      : resolved.status === 'needs-inventory'
        ? inventory.error
          ? `${resolved.machine} offline`
          : 'Finding pane…'
        : resolved.status === 'no-pane'
          ? reinit === 'idle' || reinit === 'running'
            ? 'Starting session…'
            : reinit !== 'done'
              ? reinit
              : resolved.hidden
                ? 'Hidden by the worker filter'
                : 'No pane'
          : undefined;
  return {
    selector: stable,
    run,
    native: resolved.status === 'native',
    worker,
    target,
    reason,
    /** idle, running, done, or the reinit error. */
    reinit,
    openShell: () => setShell(true),
  };
}
