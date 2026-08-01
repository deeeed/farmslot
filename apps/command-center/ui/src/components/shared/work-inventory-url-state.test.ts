import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyWorkInventorySort, parseWorkInventorySort } from './work-inventory-url-state.js';

const BACKLOG_KEYS = ['status', 'flow', 'project', 'ref', 'title', 'activity', 'updated'] as const;
const ROADMAP_KEYS = ['stage', 'project', 'id', 'title', 'promotion', 'updated'] as const;
const GRAPH_KEYS = ['status', 'project', 'id', 'title', 'progress', 'updated'] as const;
/** Production Runs persists one `sort` value (SortOption), not key+direction params. */
const RUN_SORT_OPTIONS = [
  'status',
  'status-desc',
  'flow',
  'flow-desc',
  'project',
  'project-desc',
  'ref',
  'ref-desc',
  'slot',
  'slot-desc',
  'runner',
  'runner-desc',
  'updated',
  'updated-desc',
  'newest',
  'oldest',
] as const;

test('parseWorkInventorySort falls back on invalid key and direction', () => {
  const parsed = parseWorkInventorySort(new URLSearchParams('sort=nope&direction=sideways'), {
    validKeys: BACKLOG_KEYS,
    defaultKey: 'activity',
    defaultDirection: 'desc',
  });
  assert.deepEqual(parsed, { key: 'activity', direction: 'desc' });
});

test('sort key and direction round-trip for backlog, roadmap, and work-graphs prefixes', () => {
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

test('runs production adapter round-trips every advertised inventory sort via sort=', () => {
  // Mirrors run-list-state: one SortOption in the hash `sort` param (not runSort/runDirection).
  for (const sort of RUN_SORT_OPTIONS) {
    const params = new URLSearchParams();
    if (sort !== 'newest') params.set('sort', sort);
    const raw = params.get('sort');
    const resolved = raw && (RUN_SORT_OPTIONS as readonly string[]).includes(raw) ? raw : 'newest';
    assert.equal(resolved, sort === 'newest' ? 'newest' : sort, sort);
    // Every inventory column key must map to a SortOption that survives the allow-list.
    if (sort === 'ref' || sort === 'ref-desc') assert.ok(resolved.startsWith('ref'));
    if (sort === 'slot' || sort === 'slot-desc') assert.ok(resolved.startsWith('slot'));
    if (sort === 'runner' || sort === 'runner-desc') assert.ok(resolved.startsWith('runner'));
  }
  // Invalid production sort falls back to newest (default).
  const invalid = new URLSearchParams('sort=nope');
  const rawInvalid = invalid.get('sort');
  const fallback =
    rawInvalid && (RUN_SORT_OPTIONS as readonly string[]).includes(rawInvalid)
      ? rawInvalid
      : 'newest';
  assert.equal(fallback, 'newest');
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
