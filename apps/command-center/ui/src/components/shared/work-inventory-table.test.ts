import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  inventoryShowsDetail,
  inventoryShowsList,
  isInventoryActivationKey,
  nextSortState,
  resolveSelectedRowId,
} from './work-inventory-table-model.js';
import type { WorkInventoryColumnDef, WorkInventorySortState } from './work-inventory-types.js';

const COLUMNS: WorkInventoryColumnDef<'status' | 'title' | 'updated'>[] = [
  { key: 'status', label: 'Status', width: '92px' },
  { key: 'title', label: 'Title', width: 'minmax(220px, 1fr)' },
  { key: 'updated', label: 'Updated', width: '86px' },
];

test('work-inventory-table columns accept typed descriptors and stable keys', () => {
  assert.equal(COLUMNS.length, 3);
  assert.deepEqual(
    COLUMNS.map((column) => column.key),
    ['status', 'title', 'updated'],
  );
  assert.equal(COLUMNS[0]?.sortable, undefined);
});

test('header sorting toggles without pointer-only handlers (model contract)', () => {
  let sort: WorkInventorySortState<'status' | 'title' | 'updated'> = {
    key: 'updated',
    direction: 'desc',
  };
  // Simulate header activation for title, then re-activate to flip.
  sort = nextSortState(sort, 'title', (key) => (key === 'updated' ? 'desc' : 'asc'));
  assert.deepEqual(sort, { key: 'title', direction: 'asc' });
  sort = nextSortState(sort, 'title');
  assert.deepEqual(sort, { key: 'title', direction: 'desc' });
});

test('row focus/activation uses keyboard contract, not pointer-only', () => {
  assert.equal(isInventoryActivationKey('Enter'), true);
  assert.equal(isInventoryActivationKey(' '), true);
  assert.equal(isInventoryActivationKey('Click'), false);
});

test('selected state resolves against stable row ids', () => {
  const ids = ['row-a', 'row-b', 'row-c'];
  assert.equal(resolveSelectedRowId(ids, 'row-b'), 'row-b');
  assert.equal(resolveSelectedRowId(ids, 'gone'), '');
  assert.equal(resolveSelectedRowId(['solo'], '', { autoSelectSingle: true }), 'solo');
});

test('returning from narrow-screen detail restores the inventory list', () => {
  const selectedNarrow = { hasSelection: true, narrowViewport: true, forceList: false };
  assert.equal(inventoryShowsList(selectedNarrow), false);
  assert.equal(inventoryShowsDetail(selectedNarrow), true);

  // Back affordance sets forceList — inventory becomes canonical again.
  const afterBack = { ...selectedNarrow, forceList: true };
  assert.equal(inventoryShowsList(afterBack), true);
  assert.equal(inventoryShowsDetail(afterBack), false);
});

test('renderWorkInventoryLayout keeps list mounted when hidden for detail-only', async () => {
  const { renderWorkInventoryLayout } = await import('./work-inventory-table.js');
  const { html } = await import('lit');
  const detailOnly = renderWorkInventoryLayout({
    list: html`<div data-list-scroll>list-body</div>`,
    detail: html`<div data-detail>detail-body</div>`,
    showList: false,
    showDetail: true,
  });
  const serialized = JSON.stringify(detailOnly);
  // List template remains in the tree (not replaced with nothing) so scroll can survive.
  assert.match(serialized, /list-body/);
  assert.match(serialized, /detail-body/);
  assert.match(serialized, /is-visually-hidden/);
  assert.match(serialized, /detail-only/);
});

test('renderWorkInventorySortHeader exposes aria-sort for the active column', async () => {
  const { renderWorkInventorySortHeader } = await import('./work-inventory-table.js');
  const active = renderWorkInventorySortHeader({
    label: 'Title',
    columnKey: 'title',
    sort: { key: 'title', direction: 'desc' },
    onSort: () => undefined,
  });
  const inactive = renderWorkInventorySortHeader({
    label: 'Status',
    columnKey: 'status',
    sort: { key: 'title', direction: 'desc' },
    onSort: () => undefined,
  });
  assert.match(JSON.stringify(active.values), /descending/);
  assert.match(JSON.stringify(inactive.values), /none/);
});
