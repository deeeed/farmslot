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
): (data: string) => Promise<void> {
  const queueRef = useRef<{ key: string; queue: TerminalInputQueue } | null>(null);
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
      const generation = client.connectionGeneration;
      const key = JSON.stringify([generation, worker]);
      if (queueRef.current?.key !== key) {
        queueRef.current?.queue.dispose();
        queueRef.current = {
          key,
          queue: createTerminalInputQueue(async (batch, assertActive) => {
            assertActive();
            if (client.connectionGeneration !== generation) throw new TerminalInputCancelledError();
            await client.request(Methods.TERMINAL_WORKER_INPUT, { worker, data: batch }, 10_000);
          }),
        };
      }
      return queueRef.current.queue.write(data);
    },
    [client, worker],
  );
}
