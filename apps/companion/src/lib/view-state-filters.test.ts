import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { createViewStateContext, viewListField } from '@farmslot/protocol';

let storedReads = 0;
mock.module('@react-native-async-storage/async-storage', {
  defaultExport: {
    getItem: async () => {
      storedReads++;
      return JSON.stringify({ projects: ['old'] });
    },
    setItem: async () => undefined,
  },
});

test('screen URLs own global/run filters before preferences load, including omitted defaults', async () => {
  const { bindViewStateFilters } = await import('../components/view-state-filters');
  const { useFilterStore } = await import('../store/filters');
  const { useRunFilterStore } = await import('../store/run-filters');
  let params = new URLSearchParams('projects=chosen&machines=mini&sort=oldest');
  const listeners = new Set<() => void>();
  const view = createViewStateContext({
    read: () => params,
    write(next) {
      params = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const stop = bindViewStateFilters(view);
  try {
    await useFilterStore.getState().init();
    assert.equal(storedReads, 0, 'saved preferences cannot replace an incoming URL');
    assert.deepEqual(useFilterStore.getState().filters, {
      projects: ['chosen'],
      machines: ['mini'],
    });
    assert.equal(useRunFilterStore.getState().filters.sort, 'oldest');
    useFilterStore.getState().toggleProject('second');
    assert.deepEqual(view.get(viewListField('projects', [], 'csv')), ['chosen', 'second']);
    useFilterStore.getState().clearAll();
    assert.equal(params.has('projects'), false);
    assert.equal(params.has('machines'), false);
    params = new URLSearchParams();
    for (const listener of listeners) listener();
    assert.equal(useRunFilterStore.getState().filters.sort, 'newest');
    assert.deepEqual(useFilterStore.getState().filters, { projects: [], machines: [] });
  } finally {
    stop();
  }
});
