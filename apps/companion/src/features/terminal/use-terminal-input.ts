import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';

import type { GatewayClient } from '../../lib/gateway-client';
import {
  createTerminalInputQueue,
  TerminalInputCancelledError,
  type TerminalInputQueue,
} from '../../lib/terminal-input-queue';
import type { CompanionTerminalTargetParams } from '../../lib/terminal-target';
import { useConnectionStore } from '../../store/connection';

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
): (data: string) => Promise<void> {
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const principalId = useConnectionStore((state) => state.principalId);
  const queueRef = useRef<{ key: string; client: GatewayClient; queue: TerminalInputQueue } | null>(
    null,
  );
  const disabledRef = useRef(disabledReason);
  disabledRef.current = disabledReason;
  const key = targetKey(target);

  useLayoutEffect(
    () => () => {
      queueRef.current?.queue.dispose();
      queueRef.current = null;
    },
    [client, status, profileId, principalId, key, disabledReason],
  );

  return useCallback(
    async (data: string) => {
      const connection = useConnectionStore.getState();
      const selectedClient = connection.client;
      const selectedTarget = targetRef.current;
      if (
        disabledRef.current ||
        connection.status !== 'connected' ||
        !selectedClient ||
        !selectedTarget
      )
        throw new TerminalInputCancelledError();
      const generation = selectedClient.connectionGeneration;
      const selectedKey = JSON.stringify([
        connection.activeProfileId,
        connection.principalId,
        generation,
        targetKey(selectedTarget),
      ]);
      if (queueRef.current?.key !== selectedKey || queueRef.current.client !== selectedClient) {
        queueRef.current?.queue.dispose();
        const isCurrent = () => {
          const current = useConnectionStore.getState();
          return (
            !disabledRef.current &&
            current.status === 'connected' &&
            current.client === selectedClient &&
            current.activeProfileId === connection.activeProfileId &&
            current.principalId === connection.principalId &&
            selectedClient.connectionGeneration === generation &&
            targetKey(targetRef.current) === targetKey(selectedTarget)
          );
        };
        const queue = createTerminalInputQueue(async (batch, assertActive) => {
          const assertCurrent = () => {
            assertActive();
            if (!isCurrent()) throw new TerminalInputCancelledError();
          };
          assertCurrent();
          await selectedClient.request(
            'terminal.input',
            { ...selectedTarget, data: batch },
            10_000,
            { assertCurrent },
          );
        });
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
}
