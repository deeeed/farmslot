import assert from 'node:assert/strict';
import test from 'node:test';

import { recipeToFlowGraph } from './recipe-graph-data.js';

test('recipe graph reads canonical workflow, object cases, and teardown', () => {
  const graph = recipeToFlowGraph({
    workflow: {
      entry: 'choose',
      teardown: 'cleanup',
      nodes: {
        choose: {
          action: 'switch',
          intent: 'Choose the proof path',
          cases: { yes: 'prove' },
          default: 'done',
        },
        prove: {
          action: 'assert_output',
          intent: 'Confirm the expected result',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
        cleanup: {
          action: 'command',
          intent: 'Restore the test environment',
          next: 'cleanup-done',
        },
        'cleanup-done': { action: 'end', status: 'pass' },
      },
    },
  });

  assert.ok(graph.nodes.some((node) => node.id === 'choose' && node.kind === 'decision'));
  assert.ok(
    graph.edges.some(
      (edge) => edge.from === 'choose' && edge.to === 'prove' && edge.label === 'yes',
    ),
  );
  assert.equal(graph.nodes.find((node) => node.id === 'cleanup')?.lane, 'post');
});

test('recipe graph rejects pre-v1 direct entry/nodes documents', () => {
  assert.deepEqual(recipeToFlowGraph({ entry: 'start', nodes: { start: {} } }), {
    nodes: [
      {
        id: 'error',
        kind: 'terminal',
        label: 'Invalid Recipe',
        lane: 'worker',
        annotation: 'FAIL',
      },
    ],
    edges: [],
  });
});
