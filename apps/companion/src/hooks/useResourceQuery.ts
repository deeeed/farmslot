import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { ResourceQuery, ResourceQueryState } from '@farmslot/protocol/client-cache';

import {
  getResourceCache,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../lib/resource-cache';

const loading: ResourceQueryState<never> = { status: 'loading' };

/** Observe the current owner's shared query, including its saved offline answer. */
export function useResourceQuery<T>(query: ResourceQuery<T> | undefined): ResourceQueryState<T> {
  const cache = useSyncExternalStore(subscribeResourceCache, getResourceCache, getResourceCache);
  const workspaceKey = useSyncExternalStore(
    subscribeResourceCache,
    getResourceWorkspaceKey,
    getResourceWorkspaceKey,
  );
  const subscribe = useCallback(
    (changed: () => void) => (cache && query ? cache.observe(query, changed) : () => {}),
    [cache, query, workspaceKey],
  );
  const snapshot = useCallback(
    () =>
      cache && query && cache === getResourceCache() && workspaceKey === getResourceWorkspaceKey()
        ? cache.read(query)
        : loading,
    [cache, query, workspaceKey],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Keep a stable snapshot while a variable set of family runs shares query observers. */
export function useResourceQueries<T>(
  queries: readonly ResourceQuery<T>[],
): readonly ResourceQueryState<T>[] {
  const cache = useSyncExternalStore(subscribeResourceCache, getResourceCache, getResourceCache);
  const workspaceKey = useSyncExternalStore(
    subscribeResourceCache,
    getResourceWorkspaceKey,
    getResourceWorkspaceKey,
  );
  const group = useMemo(() => {
    const empty = queries.map(() => loading);
    const current = () =>
      cache === getResourceCache() && workspaceKey === getResourceWorkspaceKey();
    let states = cache && current() ? queries.map((query) => cache.read(query)) : empty;
    return {
      snapshot: () => (current() ? states : empty),
      subscribe(changed: () => void) {
        if (!cache || !current()) return () => {};
        let active = true;
        const stops = queries.map((query, index) =>
          cache.observe(query, (state) => {
            if (!active || !current() || states[index] === state) return;
            states = states.map((previous, position) => (position === index ? state : previous));
            changed();
          }),
        );
        return () => {
          active = false;
          for (const stop of stops) stop();
        };
      },
    };
  }, [cache, workspaceKey, queries]);
  return useSyncExternalStore(group.subscribe, group.snapshot, group.snapshot);
}
