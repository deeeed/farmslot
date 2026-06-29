import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkGraphProjection } from '@farmslot/protocol';

import { computeWorkGraphLayout } from './work-graph-layout.js';

const baseTime = '2026-06-29T00:00:00.000Z';

function projection(overrides: Partial<WorkGraphProjection> = {}): WorkGraphProjection {
  return {
    graph: {
      id: 'wg_test',
      version: 1,
      project: 'farmslot-farm',
      title: 'Test graph',
      source: { kind: 'manual' },
      status: 'planning',
      defaultFailurePolicy: 'halt',
      scheduler: {},
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    nodes: [
      {
        id: 'root',
        graphId: 'wg_test',
        kind: 'backlog',
        backlogItemId: 'bl_root',
        status: 'succeeded',
        waitingOn: [],
        updatedAt: baseTime,
      },
      {
        id: 'downstream',
        graphId: 'wg_test',
        kind: 'backlog',
        backlogItemId: 'bl_downstream',
        status: 'waiting',
        waitingOn: [{ kind: 'upstream', upstreamNodeId: 'root', detail: 'root must finish' }],
        updatedAt: baseTime,
      },
    ],
    edges: [
      {
        id: 'edge_root_downstream',
        graphId: 'wg_test',
        fromNodeId: 'root',
        toNodeId: 'downstream',
        condition: { kind: 'family-done', outcome: 'success' },
        required: true,
        status: 'satisfied',
        unlock: { kind: 'mark-ready' },
      },
    ],
    gates: [],
    ledger: [],
    ...overrides,
  };
}

test('lays out dependency stages from entry nodes to downstream nodes', () => {
  const layout = computeWorkGraphLayout(projection());

  assert.deepEqual(
    layout.stages.map((stage) => stage.label),
    ['No prerequisites', 'Depends on depth 1'],
  );
  assert.equal(layout.nodes.find((node) => node.id === 'root')?.stage, 0);
  assert.equal(layout.nodes.find((node) => node.id === 'downstream')?.stage, 1);
  assert.equal(layout.edges.length, 1);
  assert.match(layout.edges[0].d, /^M /);
});

test('ignores edges whose endpoints are not in the projection', () => {
  const layout = computeWorkGraphLayout(
    projection({
      edges: [
        ...projection().edges,
        {
          id: 'missing',
          graphId: 'wg_test',
          fromNodeId: 'missing-node',
          toNodeId: 'downstream',
          condition: { kind: 'manual', gateId: 'review' },
          required: true,
          status: 'pending',
          unlock: { kind: 'mark-ready' },
        },
      ],
    }),
  );

  assert.equal(layout.edges.length, 1);
});

test('does not recurse forever if invalid cyclic data reaches the UI', () => {
  const layout = computeWorkGraphLayout(
    projection({
      edges: [
        ...projection().edges,
        {
          id: 'cycle',
          graphId: 'wg_test',
          fromNodeId: 'downstream',
          toNodeId: 'root',
          condition: { kind: 'manual', gateId: 'loop' },
          required: true,
          status: 'pending',
          unlock: { kind: 'mark-ready' },
        },
      ],
    }),
  );

  assert.equal(layout.nodes.length, 2);
  assert.equal(layout.edges.length, 2);
});

test('completion edges do not determine start-layout depth', () => {
  const layout = computeWorkGraphLayout(
    projection({
      nodes: [
        ...projection().nodes,
        {
          id: 'parallel',
          graphId: 'wg_test',
          kind: 'backlog',
          backlogItemId: 'bl_parallel',
          status: 'ready',
          waitingOn: [],
          updatedAt: baseTime,
        },
      ],
      edges: [
        ...projection().edges,
        {
          id: 'completion_rebase',
          graphId: 'wg_test',
          fromNodeId: 'downstream',
          toNodeId: 'parallel',
          condition: { kind: 'merged', targetRef: 'main' },
          blocks: 'completion',
          required: true,
          status: 'pending',
          unlock: { kind: 'rebase-onto', flow: 'merge-main' },
        },
      ],
    }),
  );

  assert.equal(layout.nodes.find((node) => node.id === 'parallel')?.stage, 0);
  assert.equal(layout.edges.length, 2);
});
