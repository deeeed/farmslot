import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { ResourceQuery, ResourceQueryState } from '@farmslot/protocol/client-cache';

import { nativeActiveRunsQuery } from './gateway-run-sync';

const states = new Map<string, ResourceQueryState>();
const observers = new Map<string, Set<(state: ResourceQueryState) => void>>();
const cache = {
  read(query: ResourceQuery<unknown>): ResourceQueryState {
    return states.get(query.id) ?? { status: 'loading' };
  },
  observe(query: ResourceQuery<unknown>, listener: (state: ResourceQueryState) => void) {
    const listeners = observers.get(query.id) ?? new Set();
    observers.set(query.id, listeners);
    listeners.add(listener);
    listener(cache.read(query));
    return () => {
      listeners.delete(listener);
    };
  },
};
function publish(query: ResourceQuery<unknown>, state: ResourceQueryState) {
  states.set(query.id, state);
  for (const listener of [...(observers.get(query.id) ?? [])]) listener(state);
}

mock.module('./resource-cache', {
  namedExports: {
    getResourceCache: () => cache,
    getResourceWorkspaceAccess: () => 'farm',
    getResourceWorkspaceKey: () => 'workspace',
    subscribeResourceCache: () => () => {},
  },
});
mock.module('../store/connection', {
  namedExports: {
    useConnectionStore: {
      getState: () => ({ status: 'disconnected', workspaceAccess: 'farm', signedOut: false }),
      subscribe: () => () => {},
    },
  },
});
mock.module('./notifications', { namedExports: { notifyDecision: async () => {} } });

test('a second app root keeps the run collections live when the first one unmounts', async () => {
  const { initializeNativeRunCollections } = await import('./run-collections');
  const { useRunStore } = await import('../store/runs');
  const departing = initializeNativeRunCollections();
  const staying = initializeNativeRunCollections();
  assert.equal(observers.get(nativeActiveRunsQuery.id)?.size, 1, 'both roots share one observer');

  departing();
  departing();
  publish(nativeActiveRunsQuery, {
    status: 'ready',
    data: { runs: [{ id: 'run-1' }], totalCount: 1 },
  });
  assert.deepEqual(
    useRunStore.getState().runs.map(({ id }) => id),
    ['run-1'],
    'the root that stays still hears the active runs',
  );

  staying();
  assert.equal(observers.get(nativeActiveRunsQuery.id)?.size, 0, 'the last root stops observing');
  assert.deepEqual(useRunStore.getState().runs, []);

  // A later mount observes again and publishes the held rows.
  const remounted = initializeNativeRunCollections();
  assert.equal(observers.get(nativeActiveRunsQuery.id)?.size, 1);
  assert.deepEqual(
    useRunStore.getState().runs.map(({ id }) => id),
    ['run-1'],
  );
  staying();
  assert.equal(observers.get(nativeActiveRunsQuery.id)?.size, 1, 'a stale release is ignored');
  remounted();
  assert.equal(observers.get(nativeActiveRunsQuery.id)?.size, 0);
});
