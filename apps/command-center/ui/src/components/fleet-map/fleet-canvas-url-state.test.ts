import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLEET_VIEW_STORAGE_KEY,
  fleetCanvasStoredFallbacks,
  fleetCanvasUrlStateFromHash,
  fleetCanvasUrlStateHash,
} from './fleet-canvas-url-state.js';

function storage(values: Record<string, string>): Pick<Storage, 'getItem'> {
  return { getItem: (key) => values[key] ?? null };
}

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

test('fleet canvas URL state falls back for invalid group and view values', () => {
  assert.deepEqual(
    fleetCanvasUrlStateFromHash('#fleet?group=unknown&view=wide', {
      groupBy: 'resource',
      viewMode: 'list',
    }),
    {
      groupBy: 'resource',
      viewMode: 'list',
      fleetRefreshOpen: false,
    },
  );
});

test('fleet canvas opens on the table unless the URL or a remembered choice says cards', () => {
  assert.equal(fleetCanvasUrlStateFromHash('#fleet').viewMode, 'list');
  assert.equal(fleetCanvasUrlStateFromHash('#fleet?view=card').viewMode, 'card');
  assert.equal(fleetCanvasUrlStateFromHash('#fleet', { viewMode: 'card' }).viewMode, 'card');
});

test('a card choice saved before the table default lapses; a later toggle is respected', () => {
  const legacy = storage({
    'farmslot:fleet-viewMode': 'card',
    'farmslot:fleet-groupBy': 'project',
  });
  assert.deepEqual(fleetCanvasUrlStateFromHash('#fleet', fleetCanvasStoredFallbacks(legacy)), {
    groupBy: 'project',
    viewMode: 'list',
    fleetRefreshOpen: false,
  });
  const toggled = storage({ [FLEET_VIEW_STORAGE_KEY]: 'card' });
  assert.equal(
    fleetCanvasUrlStateFromHash('#fleet', fleetCanvasStoredFallbacks(toggled)).viewMode,
    'card',
  );
});

test('fleet canvas hash updates preserve unrelated params', () => {
  assert.equal(
    fleetCanvasUrlStateHash(
      { groupBy: 'machine', viewMode: 'list', fleetRefreshOpen: true },
      '#fleet?projects=web&machines=m1&group=project',
    ),
    '#fleet?projects=web&machines=m1&group=machine&view=list&refresh=1',
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
