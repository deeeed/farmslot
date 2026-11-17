import type { ResourceQueryState } from '../client-cache/types.js';
import type { RunListResult } from '../rpc/run.js';

import type { RunListRow } from './list-row.js';
import { mergeRunsById } from './run-list-view.js';

const mergedViews = new WeakMap<RunListResult, WeakMap<object, RunListResult>>();
const noActiveData = {};

/** A list's history and active queries remain individually owned by the shared cache. */
export function mergeRunListObservations(
  active: ResourceQueryState<RunListResult>,
  history?: ResourceQueryState<RunListResult>,
): ResourceQueryState<RunListResult> {
  const states = history ? [history, active] : [active];
  const data = history?.data ?? active.data;
  const error = states.find((state) => state.error)?.error;
  const storageNotice = states.find((state) => state.storageNotice)?.storageNotice;
  const ready = states.every((state) => state.status === 'ready');
  const status = ready
    ? 'ready'
    : states.some((state) => state.status === 'unsupported')
      ? 'unsupported'
      : data
        ? 'stale'
        : states.some((state) => state.status === 'error')
          ? 'error'
          : 'loading';
  let mergedData: RunListResult | undefined;
  if (data) {
    let views = mergedViews.get(data);
    if (!views) {
      views = new WeakMap();
      mergedViews.set(data, views);
    }
    const activeData = active.data ?? noActiveData;
    mergedData = views.get(activeData);
    if (!mergedData) {
      const rows = new Map<string, RunListRow>();
      for (const state of states) {
        for (const run of state.data?.runs ?? []) {
          const previous = rows.get(run.id);
          // A late response to the other canonical query must not regress a newer row.
          if (!previous || run.updatedAt >= previous.updatedAt) rows.set(run.id, run);
        }
      }
      mergedData = { ...data, runs: mergeRunsById([], [...rows.values()]) };
      views.set(activeData, mergedData);
    }
  }
  const times = states.flatMap((state) =>
    state.data && state.observedAt !== undefined ? [state.observedAt] : [],
  );
  return {
    status,
    ...(mergedData ? { data: mergedData } : {}),
    ...(times.length ? { observedAt: Math.min(...times) } : {}),
    ...(error ? { error } : {}),
    ...(storageNotice ? { storageNotice } : {}),
  };
}
