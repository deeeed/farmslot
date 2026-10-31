import { useCallback, useEffect, useRef } from 'react';

import { Methods, type TmuxWorkerRef } from '@farmslot/protocol';

import type { GatewayClient } from '../../lib/gateway-client';
import {
  createTerminalInputQueue,
  TerminalInputCancelledError,
  type TerminalInputQueue,
} from '../../lib/terminal-input-queue';

/** One worker-pane request at a time, so keys reach the pane in the order typed. */
export function useWorkerTerminalInput(
  client: GatewayClient | null,
  worker: TmuxWorkerRef | null,
  onRetry?: (error: unknown, attempt: number) => void,
): (data: string) => Promise<void> {
  const queueRef = useRef<{ key: string; queue: TerminalInputQueue } | null>(null);
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;
  useEffect(
    () => () => {
      queueRef.current?.queue.dispose();
      queueRef.current = null;
    },
    [client, worker],
  );
  return useCallback(
    (data: string) => {
      if (!client || !worker) return Promise.reject(new TerminalInputCancelledError());
      // One queue per client and pane. Keys typed during a short reconnect wait in it and go
      // out once it is back; a batch that fails is retried in order, never dropped.
      const key = JSON.stringify(worker);
      if (queueRef.current?.key !== key) {
        queueRef.current?.queue.dispose();
        queueRef.current = {
          key,
          queue: createTerminalInputQueue(
            async (batch, assertActive) => {
              const generation = client.connectionGeneration;
              // Rechecked after any wait for the connection or a token refresh, before sending.
              const assertCurrent = () => {
                assertActive();
                if (client.connectionGeneration !== generation)
                  throw new TerminalInputCancelledError();
              };
              assertCurrent();
              await client.request(Methods.TERMINAL_WORKER_INPUT, { worker, data: batch }, 10_000, {
                assertCurrent,
              });
            },
            { onRetry: (error, attempt) => onRetryRef.current?.(error, attempt) },
          ),
        };
      }
      return queueRef.current.queue.write(data);
    },
    [client, worker],
  );
}
