import { useCallback, useEffect, useMemo, useRef } from 'react';

import { Methods, type TmuxWorkerRef } from '@farmslot/protocol';

import type { GatewayClient } from '../../lib/gateway-client';
import {
  createTerminalInputQueue,
  type TerminalInput,
  TerminalInputCancelledError,
  type TerminalInputQueue,
  type TerminalInputQueueOptions,
} from '../../lib/terminal-input-queue';
import { useConnectionStore } from '../../store/connection';

/** One worker-pane request at a time, so keys reach the pane in the order typed. */
export function useWorkerTerminalInput(
  client: GatewayClient | null,
  worker: TmuxWorkerRef | null,
  events: Pick<TerminalInputQueueOptions, 'onRetry' | 'onHold'> = {},
): TerminalInput {
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const principalId = useConnectionStore((state) => state.principalId);
  const queueRef = useRef<{ key: string; queue: TerminalInputQueue } | null>(null);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  useEffect(
    () => () => {
      queueRef.current?.queue.dispose();
      queueRef.current = null;
    },
    [client, worker, profileId, principalId],
  );
  const write = useCallback(
    (data: string) => {
      if (!client || !worker) return Promise.reject(new TerminalInputCancelledError());
      // One queue per client, sign-in and pane: keys typed during a short reconnect wait in it
      // and go out once it is back, and never under another profile or principal.
      const key = JSON.stringify([profileId, principalId, worker]);
      if (queueRef.current?.key !== key) {
        queueRef.current?.queue.dispose();
        queueRef.current = {
          key,
          queue: createTerminalInputQueue(
            async (batch, assertActive, markSent, seq) => {
              const generation = client.connectionGeneration;
              // Rechecked after any wait for the connection or a token refresh, before sending.
              const assertCurrent = () => {
                assertActive();
                const current = useConnectionStore.getState();
                if (
                  client.connectionGeneration !== generation ||
                  current.activeProfileId !== profileId ||
                  current.principalId !== principalId
                )
                  throw new TerminalInputCancelledError();
              };
              assertCurrent();
              // A gateway that writes each number once makes a resend after a lost reply safe.
              const sequence = client.terminalInputSequenceSupported ? { seq } : {};
              await client.request(
                Methods.TERMINAL_WORKER_INPUT,
                { worker, data: batch, ...sequence },
                10_000,
                {
                  assertCurrent,
                  onSent: markSent,
                },
              );
            },
            {
              onRetry: (error, attempt) => eventsRef.current.onRetry?.(error, attempt),
              onHold: (held) => eventsRef.current.onHold?.(held),
              resendsAreSafe: () => client.terminalInputSequenceSupported,
            },
          ),
        };
      }
      return queueRef.current.queue.write(data);
    },
    [client, worker, profileId, principalId],
  );
  const resend = useCallback(() => queueRef.current?.queue.resend(), []);
  const discard = useCallback(() => queueRef.current?.queue.discard(), []);
  return useMemo(() => ({ write, resend, discard }), [write, resend, discard]);
}
