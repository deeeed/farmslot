import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RoadmapItem } from '@farmslot/protocol';

import {
  inventoryShowsBackAffordance,
  inventoryShowsDetail,
  inventoryShowsList,
  nextSortState,
} from '../shared/work-inventory-table.js';

import { sortRoadmapItems } from './roadmap-panel-model.js';

function item(id: string, overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id,
    kind: 'roadmap-item',
    project: 'farmslot-farm',
    title: `Title ${id}`,
    stage: 'rough',
    source: { kind: 'manual' },
    body: 'body',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    filePath: `.roadmap/items/${id}.md`,
    fileHash: id,
    ...overrides,
  } as RoadmapItem;
}

/**
 * Rendered-selection contract for roadmap inventory (AC names roadmap-panel.test.ts).
 * Pure state machine mirroring roadmap-panel's layout + selection + sort wiring.
 */
function roadmapInventoryView(state: {
  selectedId: string;
  narrowViewport: boolean;
  forceList: boolean;
  sortKey: 'stage' | 'title' | 'updated';
  sortDirection: 'asc' | 'desc';
  items: RoadmapItem[];
}) {
  const sorted = sortRoadmapItems(state.items, state.sortKey, state.sortDirection);
  const selected = sorted.find((row) => row.id === state.selectedId) ?? null;
  const layout = {
    hasSelection: Boolean(selected),
    narrowViewport: state.narrowViewport,
    forceList: state.forceList,
  };
  return {
    sortedIds: sorted.map((row) => row.id),
    selectedId: selected?.id ?? '',
    showList: inventoryShowsList(layout),
    showDetail: inventoryShowsDetail(layout),
    showBack: inventoryShowsBackAffordance(layout),
    layoutMode:
      inventoryShowsList(layout) && inventoryShowsDetail(layout)
        ? 'split'
        : inventoryShowsDetail(layout)
          ? 'detail-only'
          : 'list-only',
  };
}

test('roadmap inventory selection opens detail while keeping list on wide layout', () => {
  const items = [item('ri_a', { title: 'Alpha' }), item('ri_b', { title: 'Beta' })];
  const view = roadmapInventoryView({
    selectedId: 'ri_b',
    narrowViewport: false,
    forceList: false,
    sortKey: 'title',
    sortDirection: 'asc',
    items,
  });
  assert.deepEqual(view.sortedIds, ['ri_a', 'ri_b']);
  assert.equal(view.selectedId, 'ri_b');
  assert.equal(view.layoutMode, 'split');
  assert.equal(view.showBack, false);
});

test('roadmap inventory narrow selection replaces list and Back restores list', () => {
  const items = [item('ri_a'), item('ri_b')];
  const selected = roadmapInventoryView({
    selectedId: 'ri_a',
    narrowViewport: true,
    forceList: false,
    sortKey: 'updated',
    sortDirection: 'desc',
    items,
  });
  assert.equal(selected.layoutMode, 'detail-only');
  assert.equal(selected.showList, false);
  assert.equal(selected.showDetail, true);
  assert.equal(selected.showBack, true);

  const afterBack = roadmapInventoryView({
    selectedId: 'ri_a',
    narrowViewport: true,
    forceList: true,
    sortKey: 'updated',
    sortDirection: 'desc',
    items,
  });
  assert.equal(afterBack.layoutMode, 'list-only');
  assert.equal(afterBack.showList, true);
  assert.equal(afterBack.showDetail, false);
  assert.equal(afterBack.showBack, false);
  // Selection identity is preserved across Back (canonical browsing state).
  assert.equal(afterBack.selectedId, 'ri_a');
});

test('roadmap inventory sort toggle preserves row identity for selection', () => {
  const items = [
    item('ri_z', { title: 'Zulu', stage: 'refined' }),
    item('ri_a', { title: 'Alpha', stage: 'rough' }),
  ];
  const sort = nextSortState(
    { key: 'title' as 'title' | 'stage' | 'updated', direction: 'asc' as const },
    'stage',
    (key) => (key === 'updated' ? 'desc' : 'asc'),
  );
  const view = roadmapInventoryView({
    selectedId: 'ri_z',
    narrowViewport: false,
    forceList: false,
    sortKey: sort.key as 'stage' | 'title' | 'updated',
    sortDirection: sort.direction,
    items,
  });
  assert.ok(view.sortedIds.includes('ri_z'));
  assert.equal(view.selectedId, 'ri_z');
});
