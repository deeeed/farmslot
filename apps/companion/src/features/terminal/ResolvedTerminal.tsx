import { useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import {
  Methods,
  type RunForSlotResult,
  type RunGetResult,
  type TmuxWorkerListResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { observeNativeSlotFrame, type SlotProofFrame } from '../../farmslot/run-collections-proof';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceCache } from '../../lib/resource-cache';
import {
  resolveTerminalWorkerRef,
  slotTerminalTarget,
  type TerminalSelector,
} from '../../lib/terminal-worker-ref';
import { colors, spacing } from '../../lib/theme';
import { useConnectionStore } from '../../store/connection';
import { useFleetStore } from '../../store/fleet';
import { NativeWorkerLinks } from '../native-conversation/components/NativeWorkerLinks';

import { TerminalPane, type TerminalPaneProof } from './WorkerTerminalScreen';

/** A slot, run or decision link opens the same terminal as Terminals, on the pane it names. */
export function ResolvedTerminal({
  selector,
  embedded,
  initialDraft,
}: {
  selector: TerminalSelector;
  embedded?: boolean;
  initialDraft?: string;
}) {
  const focused = useIsFocused();
  const client = useConnectionStore((s) => s.client);
  const { slotId = '', runId, contextId, role } = selector;
  const stable = useMemo(
    () => ({ slotId, runId, contextId, role }),
    [contextId, role, runId, slotId],
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
  const first = resolveTerminalWorkerRef({ selector: stable, run, slotMachine, inventory: undefined });
  const machine =
    first.status === 'needs-inventory' || first.status === 'no-pane' ? first.machine : undefined;
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
  // kept), then the inventory is read again.
  const [reinit, setReinit] = useState<string>('idle');
  const reinitKey = JSON.stringify([stable, machine]);
  const reinitFor = useRef('');
  useEffect(() => {
    if (resolved.status !== 'no-pane' || resolved.hidden || !client || run === undefined) return;
    if (reinitFor.current === reinitKey) return;
    reinitFor.current = reinitKey;
    setReinit('running');
    client
      .request(Methods.TERMINAL_REINIT, slotTerminalTarget(stable, run), 15_000)
      .then(async () => {
        if (inventoryQuery) await getResourceCache()?.retry(inventoryQuery);
        setReinit('done');
      })
      .catch((error: Error) => setReinit(error.message));
  }, [client, inventoryQuery, reinitKey, resolved, run, stable]);

  // A run refresh resolves an equal pane and target: memoized by value, the terminal keeps its
  // stream instead of subscribing again.
  const resolvedWorker = resolved.status === 'ready' ? resolved.worker : null;
  const workerKey = resolvedWorker ? JSON.stringify(resolvedWorker) : '';
  const worker = useMemo(() => resolvedWorker, [workerKey]);
  const resolvedTarget = worker ? slotTerminalTarget(stable, run ?? null) : null;
  const targetKey = JSON.stringify(resolvedTarget);
  const slotTarget = useMemo(() => resolvedTarget, [targetKey]);
  const reason =
    resolved.status === 'waiting' || resolved.status === 'unavailable'
      ? resolved.reason
      : resolved.status === 'needs-inventory'
        ? inventory.error
          ? `${resolved.machine} offline`
          : 'Finding pane…'
        : resolved.status === 'no-pane'
          ? resolved.hidden
            ? 'Hidden by the worker filter'
            : reinit === 'idle' || reinit === 'running'
              ? 'Starting session…'
              : reinit === 'done'
                ? 'No pane'
                : reinit
          : undefined;

  // Development proof frame: the shared terminal as a slot or run link sees it.
  const proof = useRef<TerminalPaneProof>({
    stream: 'connecting',
    inputs: 0,
    subscriptionStarts: 0,
    error: null,
    readOnlyReason: null,
    readText: () => '',
  });
  const frame = useRef<() => SlotProofFrame>(() => ({ focused: false, run: null }));
  frame.current = () => ({
    focused,
    run: run ?? null,
    terminalReady: Boolean(worker),
    terminalTarget: slotTerminalTarget(stable, run ?? null),
    terminalInputDisabledReason: worker ? proof.current.readOnlyReason : (reason ?? null),
    terminalStream: worker ? proof.current.stream : reason ? 'ended' : 'connecting',
    terminalControlBusy: false,
    terminalControlError: proof.current.error,
    terminalSnapshotError: worker ? null : (reason ?? null),
    readTerminalText: async () => (worker ? proof.current.readText() : ''),
    terminalInputCommands: proof.current.inputs,
    terminalSubscriptionStarts: proof.current.subscriptionStarts,
  });
  const proofRunId = run?.id ?? runId;
  useEffect(() => {
    if (__DEV__ && proofRunId)
      return observeNativeSlotFrame('terminal', proofRunId, () => frame.current());
  }, [proofRunId]);

  if (resolved.status === 'native' && run)
    return (
      <View style={{ flex: 1, backgroundColor: colors.bgBase, padding: spacing.md }}>
        <NativeWorkerLinks run={run} />
      </View>
    );

  // Another pane starts from a clean screen: the previous pane's buffer never shows under it.
  return (
    <TerminalPane
      key={worker ? `${worker.nodeId}:${worker.target}` : 'pending'}
      worker={worker}
      slotTarget={slotTarget}
      embedded={embedded}
      initialDraft={initialDraft}
      unavailableReason={reason}
      proof={proof}
    />
  );
}
