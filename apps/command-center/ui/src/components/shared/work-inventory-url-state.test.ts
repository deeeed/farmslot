import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyWorkInventorySort,
  mergeInventoryReturnParams,
  parseWorkInventorySort,
} from './work-inventory-url-state.js';

const BACKLOG_KEYS = ['status', 'flow', 'project', 'ref', 'title', 'activity', 'updated'] as const;
const ROADMAP_KEYS = ['stage', 'project', 'id', 'title', 'promotion', 'updated'] as const;
const GRAPH_KEYS = ['status', 'project', 'id', 'title', 'progress', 'updated'] as const;
const RUN_KEYS = [
  'status',
  'flow',
  'project',
  'ref',
  'slot',
  'runner',
  'updated',
  'pipeline',
] as const;

test('parseWorkInventorySort falls back on invalid key and direction', () => {
  const parsed = parseWorkInventorySort(new URLSearchParams('sort=nope&direction=sideways'), {
    validKeys: BACKLOG_KEYS,
    defaultKey: 'activity',
    defaultDirection: 'desc',
  });
  assert.deepEqual(parsed, { key: 'activity', direction: 'desc' });
});

test('sort key and direction round-trip for all four surface prefixes', () => {
  const surfaces = [
    {
      name: 'backlog',
      sortParam: 'sort',
      directionParam: 'direction',
      validKeys: BACKLOG_KEYS,
      defaultKey: 'activity' as const,
      state: { key: 'project' as const, direction: 'asc' as const },
    },
    {
      name: 'roadmap',
      sortParam: 'sort',
      directionParam: 'direction',
      validKeys: ROADMAP_KEYS,
      defaultKey: 'updated' as const,
      state: { key: 'stage' as const, direction: 'asc' as const },
    },
    {
      name: 'work-graphs',
      sortParam: 'wgSort',
      directionParam: 'wgDirection',
      validKeys: GRAPH_KEYS,
      defaultKey: 'updated' as const,
      state: { key: 'progress' as const, direction: 'desc' as const },
    },
    {
      name: 'runs',
      sortParam: 'runSort',
      directionParam: 'runDirection',
      validKeys: RUN_KEYS,
      defaultKey: 'updated' as const,
      state: { key: 'runner' as const, direction: 'asc' as const },
    },
  ];

  for (const surface of surfaces) {
    const params = applyWorkInventorySort(new URLSearchParams(), surface.state, {
      sortParam: surface.sortParam,
      directionParam: surface.directionParam,
      validKeys: surface.validKeys,
      defaultKey: surface.defaultKey,
      defaultDirection: 'desc',
    });
    const roundTrip = parseWorkInventorySort(params, {
      sortParam: surface.sortParam,
      directionParam: surface.directionParam,
      validKeys: surface.validKeys,
      defaultKey: surface.defaultKey,
      defaultDirection: 'desc',
    });
    assert.deepEqual(roundTrip, surface.state, surface.name);
  }
});

test('default sort omits params so URLs stay short', () => {
  const params = applyWorkInventorySort(
    new URLSearchParams('sort=project&direction=asc'),
    { key: 'activity', direction: 'desc' },
    {
      validKeys: BACKLOG_KEYS,
      defaultKey: 'activity',
      defaultDirection: 'desc',
    },
  );
  assert.equal(params.get('sort'), null);
  assert.equal(params.get('direction'), null);
});

test('return-from-detail preservation restores sort and selection without dropping unrelated params', () => {
  const current = new URLSearchParams('status=ready&tab=active');
  const merged = mergeInventoryReturnParams(current, {
    sortKey: 'project',
    sortDirection: 'asc',
    selectedId: 'item-42',
    selectedParam: 'item',
  });
  assert.equal(merged.get('status'), 'ready');
  assert.equal(merged.get('tab'), 'active');
  assert.equal(merged.get('sort'), 'project');
  assert.equal(merged.get('direction'), 'asc');
  assert.equal(merged.get('item'), 'item-42');

  const cleared = mergeInventoryReturnParams(merged, {
    sortKey: null,
    sortDirection: null,
    selectedId: null,
  });
  assert.equal(cleared.get('sort'), null);
  assert.equal(cleared.get('item'), null);
  assert.equal(cleared.get('status'), 'ready');
});
