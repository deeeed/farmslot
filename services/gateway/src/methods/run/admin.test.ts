import assert from 'node:assert/strict';
import test from 'node:test';

import type { HumanGrade } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { runDelete, runGetGrade, runGrade, runListTags, runSetTags } from './admin.js';

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

test('runGrade persists human grade only for terminal runs', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-grade`,
  });
  t.after(() => cleanupRun(run.id));

  const grade: HumanGrade = {
    recipe_semantic: 'good',
    reasoning: 'solid',
    graded_by: 'test',
    graded_at: '2026-06-01T00:00:00.000Z',
  };

  assert.throws(
    () => runGrade({ runId: run.id, grade }, () => {}),
    /Can only grade completed runs/,
  );

  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  const events: string[] = [];
  const result = runGrade({ runId: run.id, grade }, (event) => {
    events.push(event);
  });

  assert.deepEqual(result.run.humanGrade, grade);
  assert.deepEqual(runGetGrade({ runId: run.id }).grade, grade);
  assert.deepEqual(events, ['run.updated']);
});

test('runDelete removes the run and emits deletion', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-delete`,
  });
  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });

  const events: Array<{ event: string; payload: unknown }> = [];
  const result = await runDelete({ runId: run.id }, (event, payload) => {
    events.push({ event, payload });
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(getRun(run.id), undefined);
  assert.deepEqual(events, [{ event: 'run.deleted', payload: { runId: run.id } }]);
});

test('runSetTags normalizes tags, persists them, and emits run update', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-tags`,
  });
  t.after(() => cleanupRun(run.id));

  const events: string[] = [];
  const result = runSetTags(
    { runId: run.id, tags: [' Demo ', '#Launch Review', 'demo'] },
    (event) => {
      events.push(event);
    },
  );

  assert.deepEqual(result.run.tags, ['demo', 'launch-review']);
  assert.deepEqual(getRun(run.id)?.tags, ['demo', 'launch-review']);
  assert.deepEqual(events, ['run.updated']);
  assert(runListTags().tags.some((entry) => entry.tag === 'demo' && entry.count >= 1));
});
