import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecipeFlowProjection } from '../../recipe-runner/src/core/flow.js';
import { fixtureTree } from '../../recipe-runner/test/flow.fixture.js';
import { createEvidenceReviewModel, runEvidenceView } from '../src/evidence.js';

const tree = fixtureTree();
const time = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const view = (end: number) =>
  runEvidenceView(
    createEvidenceReviewModel({
      evidencePending: true,
      pendingTrace: [
        {
          nodeId: 'first',
          action: 'call',
          startedAt: time(0),
          endedAt: time(end),
          durationMs: end,
          ok: true,
        },
      ],
      pendingFlow: {
        tree,
        update: createRecipeFlowProjection(tree, 'timing-execution').snapshot(),
      },
    }),
  );

test('the existing view projects measured inclusive with unknown self and explicit unassigned work', () => {
  const projected = view(100);
  assert.equal(projected.flow?.recipeRunId, 'timing-execution');
  assert.deepEqual(projected.flow?.nodes.find((node) => node.id === 'first')?.timing, {
    inclusiveMs: 100,
    selfMs: null,
    qualification: { inclusive: 'measured', self: 'unknown' },
  });
  assert.ok(projected.flow?.unassignedTiming);
  assert.equal(projected.flow?.unassignedTiming.durationMs, null);
  assert.equal(projected.steps.length, 1);
});

test('a timing-only change changes snapshot equality at the same trace length and status', () => {
  const first = view(100);
  const second = view(120);
  assert.equal(first.steps.length, second.steps.length);
  assert.equal(
    first.flow?.nodes.find((node) => node.id === 'first')?.status,
    second.flow?.nodes.find((node) => node.id === 'first')?.status,
  );
  assert.notEqual(first.updateId, second.updateId);
  assert.equal(first.updateId, view(100).updateId);
});
