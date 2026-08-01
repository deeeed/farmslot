import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareInventoryValues,
  inventoryGridTemplateColumns,
  inventoryRetainsListAffordance,
  inventoryShowsBackAffordance,
  inventoryShowsDetail,
  inventoryShowsList,
  isInventoryActivationKey,
  nextSortState,
  resolveSelectedRowId,
  sortInventoryRows,
} from './work-inventory-table-model.js';

test('compareInventoryValues orders numbers and strings with numeric sensitivity', () => {
  assert.ok(compareInventoryValues(2, 10) < 0);
  assert.ok(compareInventoryValues('item-2', 'item-10') < 0);
  assert.equal(compareInventoryValues('a', 'a'), 0);
});

test('sortInventoryRows applies direction and stable tie-break', () => {
  const rows = [
    { id: 'b', title: 'Beta' },
    { id: 'a', title: 'Alpha' },
    { id: 'c', title: 'Alpha' },
  ];
  const sorted = sortInventoryRows(
    rows,
    (row) => row.title,
    'asc',
    (row) => row.id,
  );
  assert.deepEqual(
    sorted.map((row) => row.id),
    ['a', 'c', 'b'],
  );
  const desc = sortInventoryRows(
    rows,
    (row) => row.title,
    'desc',
    (row) => row.id,
  );
  assert.equal(desc[0]?.title, 'Beta');
});

test('nextSortState toggles direction on the active key and sets default on a new key', () => {
  assert.deepEqual(nextSortState({ key: 'title', direction: 'asc' }, 'title'), {
    key: 'title',
    direction: 'desc',
  });
  assert.deepEqual(
    nextSortState({ key: 'title', direction: 'asc' }, 'updated', (key) =>
      key === 'updated' ? 'desc' : 'asc',
    ),
    { key: 'updated', direction: 'desc' },
  );
});

test('inventoryGridTemplateColumns joins column widths and leading tracks', () => {
  assert.equal(
    inventoryGridTemplateColumns(
      [
        { key: 'a', label: 'A', width: '80px' },
        { key: 'b', label: 'B', width: '1fr' },
      ],
      ['30px'],
    ),
    '30px 80px 1fr',
  );
});

test('resolveSelectedRowId keeps valid selection and can auto-select a single row', () => {
  assert.equal(resolveSelectedRowId(['a', 'b'], 'b'), 'b');
  assert.equal(resolveSelectedRowId(['a', 'b'], 'missing'), '');
  assert.equal(resolveSelectedRowId(['only'], '', { autoSelectSingle: true }), 'only');
  assert.equal(resolveSelectedRowId(['a', 'b'], '', { autoSelectSingle: true }), '');
});

test('isInventoryActivationKey accepts Enter and Space only', () => {
  assert.equal(isInventoryActivationKey('Enter'), true);
  assert.equal(isInventoryActivationKey(' '), true);
  assert.equal(isInventoryActivationKey('Tab'), false);
});

test('layout helpers cover split, narrow detail replacement, and back affordance', () => {
  assert.equal(inventoryShowsList({ hasSelection: true, narrowViewport: false }), true);
  assert.equal(inventoryShowsDetail({ hasSelection: true, narrowViewport: false }), true);

  assert.equal(inventoryShowsList({ hasSelection: true, narrowViewport: true }), false);
  assert.equal(inventoryShowsDetail({ hasSelection: true, narrowViewport: true }), true);
  assert.equal(inventoryShowsBackAffordance({ hasSelection: true, narrowViewport: true }), true);

  assert.equal(
    inventoryShowsList({ hasSelection: true, narrowViewport: true, forceList: true }),
    true,
  );
  assert.equal(
    inventoryShowsDetail({ hasSelection: true, narrowViewport: true, forceList: true }),
    false,
  );
});

test('inventoryRetainsListAffordance keeps table/back for single-graph auto-select', () => {
  assert.equal(
    inventoryRetainsListAffordance({ selectedId: 'g1', rowCount: 1, autoSelected: true }),
    true,
  );
  assert.equal(
    inventoryRetainsListAffordance({ selectedId: 'g1', rowCount: 3, autoSelected: false }),
    true,
  );
  assert.equal(
    inventoryRetainsListAffordance({ selectedId: '', rowCount: 0, autoSelected: false }),
    true,
  );
});
