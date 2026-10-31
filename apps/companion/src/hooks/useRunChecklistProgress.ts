import { useMemo } from 'react';

import { Methods, type Run, type TaskProgressResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import { runChecklistProgressTarget } from '@farmslot/review-dispatch';

import { savedForDisplay, visibleReadError } from '../lib/resource-read-status';
import { useHeldConnection } from '../store/held-connection';

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
  const connected = useHeldConnection();
  // A reread in flight keeps the current label; only saved data says so.
  const saved = savedForDisplay(state, connected);
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
