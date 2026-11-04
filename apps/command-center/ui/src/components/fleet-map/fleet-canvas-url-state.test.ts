import assert from 'node:assert/strict';
import test from 'node:test';

import { fleetCanvasUrlStateFromHash, fleetCanvasUrlStateHash } from './fleet-canvas-url-state.js';

test('fleet canvas URL state parses route params and truthy refresh values', () => {
  assert.deepEqual(fleetCanvasUrlStateFromHash('#fleet?group=resource&view=list&refresh=yes'), {
    groupBy: 'resource',
    viewMode: 'list',
    fleetRefreshOpen: true,
  });
  assert.deepEqual(fleetCanvasUrlStateFromHash('#fleet?group=project&view=card&refresh=0'), {
    groupBy: 'project',
    viewMode: 'card',
    fleetRefreshOpen: false,
  });
});

test('fleet defaults are URL-owned and omit stored preferences', () => {
  assert.deepEqual(fleetCanvasUrlStateFromHash('#fleet?group=unknown&view=wide'), {
    groupBy: 'machine',
    viewMode: 'list',
    fleetRefreshOpen: false,
  });
  assert.equal(fleetCanvasUrlStateFromHash('#fleet').viewMode, 'list');
  assert.equal(fleetCanvasUrlStateFromHash('#fleet?view=card').viewMode, 'card');
});

test('fleet canvas hash updates preserve unrelated params', () => {
  assert.equal(
    fleetCanvasUrlStateHash(
      { groupBy: 'machine', viewMode: 'list', fleetRefreshOpen: true },
      '#fleet?projects=web&machines=m1&group=project',
    ),
    '#fleet?projects=web&machines=m1&refresh=1',
  );
  assert.equal(
    fleetCanvasUrlStateHash(
      { groupBy: 'project', viewMode: 'card', fleetRefreshOpen: false },
      '#fleet?projects=web&refresh=1',
    ),
    '#fleet?projects=web&group=project&view=card',
  );
  assert.equal(
    fleetCanvasUrlStateHash(
      { groupBy: 'machine', viewMode: 'card', fleetRefreshOpen: false },
      '#prs?group=project',
    ),
    null,
  );
});
