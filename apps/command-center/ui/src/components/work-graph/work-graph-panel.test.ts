import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  inventoryRetainsListAffordance,
  inventoryShowsBackAffordance,
} from '../shared/work-inventory-table.js';

import {
  resolveWorkGraphHashSelection,
  resolveWorkGraphSelection,
} from './work-graph-panel-model.js';

/**
 * Rendered selection/canvas/Back contract for Work Graph inventory
 * (AC names work-graph-panel.test.ts).
 */
function workGraphInventoryView(state: {
  filteredGraphIds: string[];
  selectedGraphId: string;
  showInventoryList: boolean;
  autoSelected: boolean;
}) {
  const retainList = inventoryRetainsListAffordance({
    selectedId: state.selectedGraphId,
    rowCount: state.filteredGraphIds.length,
    autoSelected: state.autoSelected,
  });
  const showCanvas = Boolean(state.selectedGraphId) && !state.showInventoryList;
  const showBack = showCanvas && retainList;
  return {
    showCanvas,
    showBack,
    retainList,
    // Narrow-style replacement is not required for graphs; Back returns to table.
    backAffordanceModel: inventoryShowsBackAffordance({
      hasSelection: Boolean(state.selectedGraphId),
      narrowViewport: true,
      forceList: state.showInventoryList,
    }),
  };
}

test('work-graph hash selection drops graphs outside the filtered project set', () => {
  const resolved = resolveWorkGraphHashSelection({
    filteredGraphIds: ['wg_in_project'],
    rawGraphId: 'wg_other_project',
    rawNodeId: 'node-1',
    nodeExists: () => false,
  });
  assert.equal(resolved.selectedGraphId, 'wg_in_project');
  assert.equal(resolved.selectedNodeKey, '');
  assert.equal(resolved.changed, true);
});

test('work-graph hash selection keeps node only when it belongs to the resolved graph', () => {
  const ok = resolveWorkGraphHashSelection({
    filteredGraphIds: ['wg_a', 'wg_b'],
    rawGraphId: 'wg_a',
    rawNodeId: 'n1',
    nodeExists: (graphId, nodeId) => graphId === 'wg_a' && nodeId === 'n1',
  });
  assert.equal(ok.selectedGraphId, 'wg_a');
  assert.equal(ok.selectedNodeKey, 'wg_a:n1');
  assert.equal(ok.changed, false);

  const staleNode = resolveWorkGraphHashSelection({
    filteredGraphIds: ['wg_a', 'wg_b'],
    rawGraphId: 'wg_a',
    rawNodeId: 'missing',
    nodeExists: () => false,
  });
  assert.equal(staleNode.selectedNodeKey, '');
  assert.equal(staleNode.changed, true);
});

test('single-graph auto-selection opens canvas with Back affordance to inventory', () => {
  const { selectedId, autoSelected } = resolveWorkGraphSelection(['wg_solo'], '');
  assert.equal(selectedId, 'wg_solo');
  assert.equal(autoSelected, true);
  const open = workGraphInventoryView({
    filteredGraphIds: ['wg_solo'],
    selectedGraphId: selectedId,
    showInventoryList: false,
    autoSelected,
  });
  assert.equal(open.showCanvas, true);
  assert.equal(open.showBack, true);

  const afterBack = workGraphInventoryView({
    filteredGraphIds: ['wg_solo'],
    selectedGraphId: selectedId,
    showInventoryList: true,
    autoSelected,
  });
  assert.equal(afterBack.showCanvas, false);
  assert.equal(afterBack.showBack, false);
});

test('multi-graph inventory selection opens canvas and Back returns to table', () => {
  const open = workGraphInventoryView({
    filteredGraphIds: ['wg_a', 'wg_b'],
    selectedGraphId: 'wg_b',
    showInventoryList: false,
    autoSelected: false,
  });
  assert.equal(open.showCanvas, true);
  assert.equal(open.showBack, true);

  const list = workGraphInventoryView({
    filteredGraphIds: ['wg_a', 'wg_b'],
    selectedGraphId: 'wg_b',
    showInventoryList: true,
    autoSelected: false,
  });
  assert.equal(list.showCanvas, false);
});
