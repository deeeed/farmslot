import { useMemo } from 'react';

import { Methods, type Run, type TaskProgressResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import { runChecklistProgressTarget } from '@farmslot/review-dispatch';

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
  return target
    ? {
        key: target.key,
        progress: state.data?.structured ?? null,
        error: state.error?.message,
        stale: state.status !== 'ready',
        observedAt: state.observedAt,
      }
    : null;
}
