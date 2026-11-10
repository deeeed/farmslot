import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceQuery } from '@farmslot/protocol/client-cache';

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
