import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '../../src/contracts/runs.js';
import { trimRunForList } from '../../src/runs/list-trim.js';
import { runListProjection } from '../../src/runs/run-list-filter.js';
import { storedRun } from '../fixtures/run.js';

test('run list and summary projections omit decision history without changing the run', () => {
  const archived: RunDecision = {
    id: 'archived',
    type: 'engine_human_gate',
    title: 'Publish',
    description: 'x'.repeat(1_000_000),
    actions: [],
    createdAt: '2026-11-03T00:00:00.000Z',
  };
  const run = storedRun('history', { decisionHistory: [archived] });
  const listed = trimRunForList(run);
  assert.equal(Object.hasOwn(listed, 'decisionHistory'), false);
  assert.equal(Object.hasOwn(runListProjection(run), 'decisionHistory'), false);
  assert.deepEqual(run.decisionHistory, [archived]);
  assert.ok(JSON.stringify(listed).length < 1000);
});
