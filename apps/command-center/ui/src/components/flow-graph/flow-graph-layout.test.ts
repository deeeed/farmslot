import assert from 'node:assert/strict';
import test from 'node:test';

import type { FlowGraph, FlowGraphEdge } from './flow-graph-data.js';
import {
  computeEdgePath,
  computeGraphLayout,
  DECISION_SIZE,
  executorToLane,
  getNeighborhood,
  type LayoutNode,
} from './flow-graph-layout.js';

const graph: FlowGraph = {
  nodes: [
    { id: 'start', kind: 'step', label: 'Start', lane: 'orch', executor: 'gateway' },
    { id: 'work', kind: 'step', label: 'Work', lane: 'worker', executor: 'worker' },
    { id: 'review', kind: 'decision', label: 'Review?', lane: 'worker', executor: 'reviewer' },
    { id: 'done', kind: 'terminal', label: 'Done', lane: 'post', executor: 'human' },
    {
      id: 'skipped',
      kind: 'step',
      label: 'Skipped',
      lane: 'post',
      executor: 'gateway',
      skipped: true,
    },
  ],
  edges: [
    { from: 'start', to: 'work', style: 'normal' },
    { from: 'work', to: 'review', style: 'conditional', label: 'check' },
    { from: 'review', to: 'done', style: 'normal' },
    { from: 'done', to: 'missing', style: 'normal' },
  ],
};

test('flow graph layout keeps phase lanes, compact decision nodes, and valid edges', () => {
  const layout = computeGraphLayout(graph, 'phase');

  assert.deepEqual(
    layout.lanes.map((lane) => lane.label),
    ['ORCH', 'WORKER', 'POST'],
  );
  assert.equal(layout.nodes.length, graph.nodes.length);
  assert.equal(layout.edges.length, 3, 'edges with missing endpoints are omitted');

  const decision = layout.nodes.find((node) => node.id === 'review');
  assert.equal(decision?.w, DECISION_SIZE * 2 + 12);
  assert.equal(decision?.h, DECISION_SIZE * 2 + 12);
  assert.equal(layout.laneSepYs.length, 2);
  assert.ok(layout.width > 0);
  assert.ok(layout.height > 0);
});

test('flow graph layout can group executor lanes without losing reviewer nodes', () => {
  assert.equal(executorToLane('worker'), 'runner');
  assert.equal(executorToLane('reviewer'), 'runner');
  assert.equal(executorToLane('human'), 'human');

  const layout = computeGraphLayout(graph, 'executor');
  assert.deepEqual(
    layout.lanes.map((lane) => lane.label),
    ['GATEWAY', 'RUNNER', 'HUMAN'],
  );
  assert.equal(layout.nodes.find((node) => node.id === 'review')?.node.executor, 'reviewer');
});

test('flow graph neighborhood and edge path helpers stay deterministic', () => {
  const neighborhood = getNeighborhood(graph, 'review');
  assert.deepEqual(
    neighborhood.preds.map((node) => node.id),
    ['work'],
  );
  assert.deepEqual(
    neighborhood.succs.map((node) => node.id),
    ['done'],
  );
  assert.equal(neighborhood.edges.length, 2);

  const src: LayoutNode = { id: 'a', node: graph.nodes[0], x: 10, y: 10, w: 100, h: 40 };
  const sameLaneTarget: LayoutNode = {
    id: 'b',
    node: graph.nodes[1],
    x: 160,
    y: 10,
    w: 100,
    h: 40,
  };
  const crossLaneTarget: LayoutNode = {
    id: 'c',
    node: graph.nodes[3],
    x: 160,
    y: 120,
    w: 100,
    h: 40,
  };
  const edge: FlowGraphEdge = { from: 'a', to: 'b', style: 'normal' };

  assert.equal(computeEdgePath(src, sameLaneTarget, edge), 'M 110 30 L 160 30');
  assert.match(computeEdgePath(src, crossLaneTarget, edge), /^M 60 50 C 60 85, 210 85, 210 120$/);
  assert.match(
    computeEdgePath(src, sameLaneTarget, { ...edge, style: 'loop' }),
    /^M 110 30 C 140 -20, 130 -20, 160 30$/,
  );
});
