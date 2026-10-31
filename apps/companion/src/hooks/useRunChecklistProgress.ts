import { useMemo } from 'react';

import { Methods, type Run, type TaskProgressResult } from '@farmslot/protocol';
import { heldDataIsSaved, resourceQuery } from '@farmslot/protocol/client-cache';
import { runChecklistProgressTarget } from '@farmslot/review-dispatch';

import { visibleReadError } from '../lib/resource-read-status';
import { useConnectionStore } from '../store/connection';

import { useResourceQuery } from './useResourceQuery';

/** List rows share the current owner's canonical checklist observation. */
export function useRunChecklistProgress(run: Run) {
  const target = runChecklistProgressTarget(run);
  const key = target?.key;
  const query = useMemo(
    () =>
      target ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, target.params) : undefined,
    [key],
  );
  const state = useResourceQuery(query);
  const connected = useConnectionStore(
    (connection) =>
      connection.status === 'connected' && connection.client?.connectionState === 'connected',
  );
  // A reread in flight keeps the current label; only saved data says so.
  const saved = heldDataIsSaved(state, connected);
  return target
    ? {
        key: target.key,
        progress: state.data?.structured ?? null,
        error: visibleReadError(state, saved)?.message,
        stale: saved,
        observedAt: state.observedAt,
      }
    : null;
}
