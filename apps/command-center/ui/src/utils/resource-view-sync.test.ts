import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nativeObservationQuery,
  resourceQuery,
  type ResourceQueryState,
  resourceSyncState,
} from '@farmslot/protocol/client-cache';

import { resourceViewMatches } from './resource-view-sync.js';

test('a current run list is not labelled cached by an unrelated projects read', () => {
  assert.equal(resourceViewMatches('runs', resourceQuery('run.list')), true);
  assert.equal(resourceViewMatches('runs', resourceQuery('config.projects')), false);
  assert.equal(resourceViewMatches('fleet', resourceQuery('fleet.status')), true);
  assert.equal(resourceViewMatches('slot/slot-1', resourceQuery('fleet.status')), true);
  assert.equal(
    resourceViewMatches(
      'family/family-1',
      resourceQuery('family.observability.get', { familyId: 'family-1' }),
    ),
    true,
  );
  assert.equal(resourceViewMatches('new-view', resourceQuery('config.projects')), true);
});

test('native and compare views select their actual primary reads', () => {
  assert.equal(
    resourceViewMatches('native', nativeObservationQuery('native.session.list', {}, 'reader')),
    true,
  );
  assert.equal(
    resourceViewMatches('native', nativeObservationQuery('native.session.catalog', {}, 'reader')),
    true,
  );
  assert.equal(
    resourceViewMatches('runs/compare', resourceQuery('run.get', { runId: 'left' })),
    true,
  );
  assert.equal(
    resourceViewMatches('runs/compare', resourceQuery('run.get', { runId: 'right' })),
    true,
  );
  assert.equal(resourceViewMatches('runs/compare', resourceQuery('run.list')), false);
});

test('native primary reads report synced and timestamped cached states', () => {
  const queries = [
    nativeObservationQuery('native.session.list', {}, 'reader'),
    nativeObservationQuery('native.session.catalog', {}, 'reader'),
  ];
  const reads = queries
    .filter((query) => resourceViewMatches('native', query))
    .map(() => ({ status: 'ready' as const, data: {}, observedAt: 1000 }));
  assert.deepEqual(resourceSyncState(reads, true), { status: 'synced' });
  assert.deepEqual(resourceSyncState(reads, false), { status: 'cached', observedAt: 1000 });
});

test('a failed comparison read cannot borrow currentness from the background run list', () => {
  const cases: Array<{ query: ReturnType<typeof resourceQuery>; state: ResourceQueryState }> = [
    {
      query: resourceQuery('run.get', { runId: 'left' }),
      state: { status: 'error', error: { code: 'UNAVAILABLE', message: 'Read failed' } },
    },
    { query: resourceQuery('run.get', { runId: 'right' }), state: { status: 'ready', data: {} } },
    { query: resourceQuery('run.list'), state: { status: 'ready', data: {} } },
  ];
  const reads = cases
    .filter(({ query }) => resourceViewMatches('runs/compare', query))
    .map(({ state }) => state);
  assert.deepEqual(resourceSyncState(reads, true), { status: 'syncing' });
});
