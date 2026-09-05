/**
 * Reads the Gateway's resource posture for one run (ADR-054).
 *
 * The run record carries the persisted desired policy, but only
 * `runtime.posture.status` re-merges it with what the providers are observed to
 * be doing. Rendering a posture from `run.resourcePosture` alone would show
 * intent as if it were fact, so every surface reads it through this hook.
 */
import { useEffect, useRef, useState } from 'react';

import { Methods, type RuntimePostureStatusResult } from '@farmslot/protocol';

import type { GatewayClient } from '../lib/gateway-client';
import { isGatewayBackgroundPauseError } from '../lib/recoverable-errors';
import type { RunPostureStatusState } from '../lib/run-resource-posture';

export function useRunResourcePosture(
  client: GatewayClient | null,
  runId: string | null,
  /** Changes whenever the run record changed, so the status is re-read with it. */
  refreshKey: string,
): { posture: RunPostureStatusState } {
  const [posture, setPosture] = useState<RunPostureStatusState>({ status: 'idle' });
  const requestRef = useRef(0);

  useEffect(() => {
    if (!client || !runId) {
      // A posture belongs to the run it was read for; carrying it across would
      // describe the previous run's providers under this run's id.
      requestRef.current += 1;
      setPosture({ status: 'idle' });
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setPosture((current) =>
      current.status === 'idle' ? { status: 'loading' } : { ...current, status: 'loading' },
    );
    client
      .request<RuntimePostureStatusResult>(Methods.RUNTIME_POSTURE_STATUS, { runId })
      .then((result) => {
        if (requestRef.current !== requestId) return;
        setPosture({ status: 'ready', slotId: result.slotId, state: result.state });
      })
      .catch((err: Error) => {
        if (requestRef.current !== requestId) return;
        if (isGatewayBackgroundPauseError(err)) {
          // App backgrounding pauses gateway requests routinely. The last posture
          // read is still the Gateway's answer, and the next refresh replaces it,
          // so it is kept rather than replaced with an error the operator cannot act on.
          console.warn(`Resource posture refresh paused: ${err.message}`);
          setPosture((current) =>
            current.state ? { ...current, status: 'ready' } : { status: 'idle' },
          );
          return;
        }
        // Never fall back to "no posture": an unreadable status is its own state.
        setPosture({ status: 'error', message: `Posture status unavailable: ${err.message}` });
      });
  }, [client, refreshKey, runId]);

  return { posture };
}
