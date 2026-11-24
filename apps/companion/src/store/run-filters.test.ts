import assert from 'node:assert/strict';
import test from 'node:test';

import { restoredRunFilters } from './run-filters';

test('saved run filters restore their known choices', () => {
  assert.deepEqual(
    restoredRunFilters({
      flow: 'qa',
      lane: 'product',
      sort: 'oldest',
      search: 'x',
      tag: 'nightly',
    }),
    { flow: 'qa', lane: 'product', sort: 'oldest', search: '', tag: 'nightly' },
  );
});

test('a choice this build does not know falls back instead of hiding every run', () => {
  assert.deepEqual(restoredRunFilters({ lane: 'future-lane', sort: 'random', flow: 3 }), {
    flow: '',
    lane: '',
    sort: 'newest',
    search: '',
    tag: '',
  });
});
