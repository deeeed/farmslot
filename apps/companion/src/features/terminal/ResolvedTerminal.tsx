import { useIsFocused } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Pressable, Text, View } from 'react-native';

import { observeNativeSlotFrame, type SlotProofFrame } from '../../farmslot/run-collections-proof';
import { slotTerminalTarget, type TerminalSelector } from '../../lib/terminal-worker-ref';
import { colors, spacing } from '../../lib/theme';
import { NativeWorkerLinks } from '../native-conversation/components/NativeWorkerLinks';

import { useResolvedTerminal } from './use-resolved-terminal';
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
  const resolved = useResolvedTerminal(selector);
  const { run, worker, target, reason } = resolved;

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
    terminalTarget: target ?? slotTerminalTarget(resolved.selector, run ?? null),
    terminalInputDisabledReason: worker ? proof.current.readOnlyReason : (reason ?? null),
    terminalStream: worker ? proof.current.stream : reason ? 'ended' : 'connecting',
    terminalControlBusy: false,
    terminalControlError: proof.current.error,
    terminalSnapshotError: worker ? null : (reason ?? null),
    readTerminalText: async () => (worker ? proof.current.readText() : ''),
    terminalInputCommands: proof.current.inputs,
    terminalSubscriptionStarts: proof.current.subscriptionStarts,
  });
  const proofRunId = run?.id ?? selector.runId;
  useEffect(() => {
    if (__DEV__ && proofRunId)
      return observeNativeSlotFrame('terminal', proofRunId, () => frame.current());
  }, [proofRunId]);

  if (resolved.native && run)
    return (
      <View style={{ flex: 1, backgroundColor: colors.bgBase, padding: spacing.md }}>
        <NativeWorkerLinks run={run} />
        {selector.slotId ? (
          <Pressable
            accessibilityRole="button"
            testID="companion-terminal-slot-shell"
            style={{ paddingVertical: spacing.sm }}
            onPress={resolved.openShell}
          >
            <Text style={{ color: colors.accent }}>Slot shell</Text>
          </Pressable>
        ) : null}
      </View>
    );

  // Another pane starts from a clean screen: the previous pane's buffer never shows under it.
  return (
    <TerminalPane
      key={worker ? `${worker.nodeId}:${worker.target}` : 'pending'}
      worker={worker}
      slotTarget={target}
      embedded={embedded}
      initialDraft={initialDraft}
      unavailableReason={reason}
      proof={proof}
    />
  );
}
