import assert from 'node:assert/strict';
import test from 'node:test';

import { DeferredSlotReleases } from './deferred-slot-release.js';

test('a late old-generation callback cannot replace or delete a successor release', () => {
  let generation = 1;
  const releases = new DeferredSlotReleases((_runId, candidate) => candidate === generation);
  releases.defer('run', 1, { slotId: 'old-slot' });
  generation = 2;
  releases.defer('run', 2, { slotId: 'new-slot' });
  releases.defer('run', 1, { slotId: 'late-old-slot' });
  assert.equal(releases.take('run', 1), undefined);
  assert.deepEqual(releases.take('run', 2), { slotId: 'new-slot' });
  assert.equal(releases.take('run', 2), undefined);
});

test('a successor never inherits a release its predecessor left behind', () => {
  const releases = new DeferredSlotReleases(() => true);
  releases.defer('run', 1, { slotId: 'old-slot' });
  assert.equal(releases.take('run', 2), undefined);
  assert.deepEqual(releases.take('run', 1), { slotId: 'old-slot' });
});
