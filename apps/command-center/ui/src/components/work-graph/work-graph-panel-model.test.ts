import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WorkGraphProjection } from '@farmslot/protocol';

import { inventoryRetainsListAffordance } from '../shared/work-inventory-table.js';

import {
  resolveWorkGraphSelection,
  sortWorkGraphInventory,
  workGraphInventoryStats,
} from './work-graph-panel-model.js';

function node(
  graphId: string,
  id: string,
  status: WorkGraphProjection['nodes'][number]['status'],
  title: string,
): WorkGraphProjection['nodes'][number] {
  return {
    id,
    graphId,
    kind: 'backlog',
    status,
    title,
    waitingOn: [],
    updatedAt: '2026-07-01T00:00:00.000Z',
  } as WorkGraphProjection['nodes'][number];
}

function graph(
  id: string,
  overrides: Partial<WorkGraphProjection['graph']> & {
    nodes?: WorkGraphProjection['nodes'];
  } = {},
): WorkGraphProjection {
  const { nodes, ...graphOverrides } = overrides;
  return {
    graph: {
      id,
      title: `Graph ${id}`,
      project: 'project-a',
      status: 'active',
      updatedAt: '2026-07-01T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      ...graphOverrides,
    },
    nodes: nodes ?? [
      node(id, `${id}-n1`, 'succeeded', 'Done'),
      node(id, `${id}-n2`, 'running', 'Active'),
      node(id, `${id}-n3`, 'waiting', 'Blocked'),
    ],
    edges: [],
    gates: [],
    ledger: [],
  } as unknown as WorkGraphProjection;
}

test('workGraphInventoryStats counts progress, active, and blocked nodes', () => {
  const stats = workGraphInventoryStats(graph('g1'));
  assert.equal(stats.total, 3);
  assert.equal(stats.active, 1);
  assert.equal(stats.blocked, 1);
  assert.equal(stats.progress, 33);
});

test('sortWorkGraphInventory orders by project then id', () => {
  const sorted = sortWorkGraphInventory(
    [graph('b', { project: 'zeta', title: 'B' }), graph('a', { project: 'alpha', title: 'A' })],
    'project',
    'asc',
  );
  assert.deepEqual(
    sorted.map((item) => item.graph.id),
    ['a', 'b'],
  );
});

test('single-graph auto-selection retains a visible table/back affordance', () => {
  const only = graph('solo');
  const { selectedId, autoSelected } = resolveWorkGraphSelection([only.graph.id], '');
  assert.equal(selectedId, 'solo');
  assert.equal(autoSelected, true);
  assert.equal(
    inventoryRetainsListAffordance({
      selectedId,
      rowCount: 1,
      autoSelected,
    }),
    true,
  );
});

test('resolveWorkGraphSelection clears stale multi-graph selection', () => {
  const resolved = resolveWorkGraphSelection(['a', 'b'], 'missing');
  assert.equal(resolved.selectedId, '');
  assert.equal(resolved.autoSelected, false);
});
