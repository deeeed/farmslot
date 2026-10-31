import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import type { GatewayClient } from '../../lib/gateway-client';
import {
  assertSafeResend,
  createTerminalInputQueue,
  type TerminalInput,
  TerminalInputCancelledError,
  type TerminalInputQueue,
  type TerminalInputQueueOptions,
} from '../../lib/terminal-input-queue';
import type { CompanionTerminalTargetParams } from '../../lib/terminal-target';
import { useConnectionStore } from '../../store/connection';
import { heldConnectionCurrent } from '../../store/held-connection';

function targetKey(target: CompanionTerminalTargetParams | null): string {
  return JSON.stringify([
    target?.slotId,
    target?.runId,
    target?.role,
    target?.contextId,
    target?.bareSession,
  ]);
}

export function useTerminalInput(
  target: CompanionTerminalTargetParams | null,
  targetRef: RefObject<CompanionTerminalTargetParams | null>,
  disabledReason: string | null,
  events: Pick<TerminalInputQueueOptions, 'onRetry' | 'onHold'> = {},
): TerminalInput {
  const client = useConnectionStore((state) => state.client);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const principalId = useConnectionStore((state) => state.principalId);
  const queueRef = useRef<{ key: string; client: GatewayClient; queue: TerminalInputQueue } | null>(
    null,
  );
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const disabledRef = useRef(disabledReason);
  disabledRef.current = disabledReason;
  const key = targetKey(target);

  useLayoutEffect(
    () => () => {
      queueRef.current?.queue.dispose();
      queueRef.current = null;
    },
    [client, profileId, principalId, key, disabledReason],
  );

  const write = useCallback(
    async (data: string) => {
      const connection = useConnectionStore.getState();
      const selectedClient = connection.client;
      const selectedTarget = targetRef.current;
      // A short reconnect keeps typing: keys queue and go out once the connection is back.
      if (disabledRef.current || !heldConnectionCurrent() || !selectedClient || !selectedTarget)
        throw new TerminalInputCancelledError();
      const selectedKey = JSON.stringify([
        connection.activeProfileId,
        connection.principalId,
        targetKey(selectedTarget),
      ]);
      if (queueRef.current?.key !== selectedKey || queueRef.current.client !== selectedClient) {
        queueRef.current?.queue.dispose();
        const isCurrent = (generation: number) => {
          const current = useConnectionStore.getState();
          return (
            !disabledRef.current &&
            heldConnectionCurrent() &&
            current.client === selectedClient &&
            current.activeProfileId === connection.activeProfileId &&
            current.principalId === connection.principalId &&
            selectedClient.connectionGeneration === generation &&
            targetKey(targetRef.current) === targetKey(selectedTarget)
          );
        };
        const queue = createTerminalInputQueue(
          async (batch, assertActive, markSent, seq, sentTo) => {
            // Each attempt belongs to the connection it starts on; one stopped before it was
            // sent is retried in order on the next.
            const generation = selectedClient.connectionGeneration;
            const assertCurrent = () => {
              assertActive();
              if (!isCurrent(generation)) throw new TerminalInputCancelledError();
              // Only a live connection says which instance would receive the frame; the last
              // check runs connected, just before the frame is written.
              if (selectedClient.connectionState === 'connected')
                assertSafeResend(sentTo, selectedClient.terminalInputSequenceInstance);
            };
            assertCurrent();
            await selectedClient.request(
              'terminal.input',
              { ...selectedTarget, data: batch, seq },
              10_000,
              {
                assertCurrent,
                onSent: () => markSent(selectedClient.terminalInputSequenceInstance),
              },
            );
          },
          {
            onRetry: (error, attempt) => eventsRef.current.onRetry?.(error, attempt),
            onHold: (held) => eventsRef.current.onHold?.(held),
          },
        );
        queueRef.current = { key: selectedKey, client: selectedClient, queue };
      }
      const selected = queueRef.current;
      try {
        await selected.queue.write(data);
        if (queueRef.current !== selected) throw new TerminalInputCancelledError();
      } catch (error) {
        if (queueRef.current !== selected) throw new TerminalInputCancelledError();
        throw error;
      }
    },
    [targetRef],
  );
  const resend = useCallback(() => queueRef.current?.queue.resend(), []);
  const discard = useCallback(() => queueRef.current?.queue.discard(), []);
  return useMemo(() => ({ write, resend, discard }), [write, resend, discard]);
}
