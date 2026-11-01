import { useMemo, useRef } from 'react';

import { Methods, type Run, type TaskProgressResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import { runChecklistProgressTarget } from '@farmslot/review-dispatch';

import { savedForDisplay, visibleReadError } from '../lib/resource-read-status';
import { useHeldConnection } from '../store/held-connection';

import { useResourceQuery } from './useResourceQuery';

/**
 * List rows share the current owner's canonical checklist observation. A row that is not `live`
 * (its list is hidden) stops observing and keeps the last answer it showed.
 */
export function useRunChecklistProgress(run: Run, live = true) {
  const target = runChecklistProgressTarget(run);
  const key = target?.key;
  const query = useMemo(
    () =>
      target ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, target.params) : undefined,
    [key],
  );
  const observed = useResourceQuery(live ? query : undefined);
  const shown = useRef(observed);
  if (live) shown.current = observed;
  const state = live ? observed : shown.current;
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
