import assert from 'node:assert/strict';
import test from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import {
  resolveBoundTerminalRunForSlot,
  runRecipeRunsForRun,
  selectActiveRunForSlot,
  selectRecipeRunId,
} from './context.js';
import { makeRun } from './test-fixtures.js';

test('selectRecipeRunId prefers exact recipe run context before artifact root', () => {
  const recipeRuns = [
    { id: 'bundle', recipeRunId: null, artifactRoot: '/tmp/bundle' },
    { id: 'attempt', recipeRunId: 'attempt-1', artifactRoot: '/tmp/attempt' },
    { id: 'promoted', recipeRunId: 'promoted-1', artifactRoot: '/tmp/promoted' },
  ];

  assert.equal(
    selectRecipeRunId(recipeRuns, { recipeRunId: 'promoted-1', artifactRoot: '/tmp/attempt' }),
    'promoted',
  );
});

test('selectRecipeRunId falls back to artifact root then first group', () => {
  const recipeRuns = [
    { id: 'bundle', recipeRunId: null, artifactRoot: '/tmp/bundle' },
    { id: 'attempt', recipeRunId: 'attempt-1', artifactRoot: '/tmp/attempt' },
  ];

  assert.equal(
    selectRecipeRunId(recipeRuns, { recipeRunId: 'missing', artifactRoot: '/tmp/attempt' }),
    'attempt',
  );
  assert.equal(
    selectRecipeRunId(recipeRuns, { recipeRunId: 'missing', artifactRoot: null }),
    'bundle',
  );
  assert.equal(
    selectRecipeRunId([], { recipeRunId: 'missing', artifactRoot: '/tmp/attempt' }),
    null,
  );
});

test('runRecipeRunsForRun throws for missing run id', async () => {
  await assert.rejects(
    () => runRecipeRunsForRun({ runId: 'missing-recipe-run' }),
    /Run not found: missing-recipe-run/,
  );
});

test('runRecipeRunsForRun returns empty groups for a run without recipe artifacts', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-RECIPE-RUNS-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Exercise recipe run artifact listing',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const result = await runRecipeRunsForRun({ runId: run.id });

  assert.deepEqual(result, { recipeRuns: [], selectedRecipeRunId: null });
});

test('selectActiveRunForSlot refuses ambiguous slot ownership without currentRunId', () => {
  const older = makeRun({
    id: 'older',
    slotId: 'slot-a',
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:00.000Z',
  });
  const newer = makeRun({
    id: 'newer',
    slotId: 'slot-a',
    createdAt: '2026-04-16T00:00:00.000Z',
    updatedAt: '2026-04-16T00:00:00.000Z',
  });
  assert.equal(selectActiveRunForSlot('slot-a', [older, newer]), null);
});

test('resolveBoundTerminalRunForSlot returns terminal runs bound via load-run pointer', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: `LOAD-BIND-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Bound terminal run for slot replay',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  updateRun(run.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    taskFile: '/tmp/tasks/load-bind/TASK.md',
  });

  assert.equal(resolveBoundTerminalRunForSlot(run.id)?.id, run.id);
  assert.equal(resolveBoundTerminalRunForSlot('missing-run-id'), null);
});

test('selectActiveRunForSlot prefers currentRunId over ambiguous slot matches', () => {
  const older = makeRun({
    id: 'older',
    slotId: 'slot-a',
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:00.000Z',
  });
  const newer = makeRun({
    id: 'newer',
    slotId: 'slot-a',
    createdAt: '2026-04-16T00:00:00.000Z',
    updatedAt: '2026-04-16T00:00:00.000Z',
  });
  assert.equal(selectActiveRunForSlot('slot-a', [older, newer], 'older')?.id, 'older');
});
