import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, WorkGraphMethods, type WorkGraphProjection } from '../../src/index.js';

test('work graph protocol exports method constants and v1 projection shape', () => {
  assert.equal(WorkGraphMethods.create, Methods.WORK_GRAPH_CREATE);
  assert.equal(WorkGraphMethods.schedulerTick, 'workGraph.schedulerTick');

  const projection: WorkGraphProjection = {
    graph: {
      id: 'wg_demo',
      version: 1,
      project: 'farmslot-farm',
      title: 'Demo graph',
      source: { kind: 'manual' },
      status: 'planning',
      defaultFailurePolicy: 'halt',
      scheduler: {},
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z',
    },
    nodes: [
      {
        id: 'wn_demo',
        graphId: 'wg_demo',
        kind: 'backlog',
        backlogItemId: 'backlog-1',
        status: 'waiting',
        waitingOn: [{ kind: 'upstream', edgeId: 'we_demo', detail: 'Waiting on upstream' }],
        updatedAt: '2026-06-29T00:00:00.000Z',
      },
    ],
    edges: [
      {
        id: 'we_demo',
        graphId: 'wg_demo',
        fromNodeId: 'wn_upstream',
        toNodeId: 'wn_demo',
        condition: { kind: 'family-done' },
        required: true,
        status: 'pending',
        unlock: { kind: 'enqueue' },
      },
    ],
    gates: [],
    ledger: [],
  };

  assert.equal(projection.nodes[0]?.waitingOn[0]?.kind, 'upstream');
});
