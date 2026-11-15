import { useMemo } from 'react';

import {
  Methods,
  type NativeSessionTargetParams,
  type NativeSessionTurnDiffResult,
} from '@farmslot/protocol';
import { nativeObservationQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceNativeOwnerId } from '../../lib/resource-cache';

/** One file's diff for a turn, read from the shared cache while `open`. */
export function useNativeTurnDiff(
  target: NativeSessionTargetParams | undefined,
  sequence: number,
  path: string,
  open: boolean,
) {
  const owner = getResourceNativeOwnerId();
  const query = useMemo(
    () =>
      open && target && owner
        ? nativeObservationQuery<NativeSessionTurnDiffResult>(
            Methods.NATIVE_SESSION_TURN_DIFF,
            {
              sessionId: target.sessionId,
              ...(target.executionNodeId ? { executionNodeId: target.executionNodeId } : {}),
              ...(target.worker ? { worker: target.worker } : {}),
              sequence,
              path,
            },
            owner,
          )
        : undefined,
    // The conversation keeps one target object per session and worker binding.
    [open, target, owner, sequence, path],
  );
  return useResourceQuery(query);
}
