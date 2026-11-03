import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import { deleteTestRunIfPresent } from '../run-engine/test-fixtures.js';

import {
  archiveRun,
  buildRunRecord,
  commitRunPublication,
  createRun,
  deleteArchivedRun,
  getRun,
  getRunWithArchived,
  isSyntheticLeak,
  persistRunNow,
  runsDirectory,
  updateRun,
} from './store.js';

const row = (description: string): RunDecision => ({
  id: 'repeated-id',
  type: 'engine_human_gate',
  title: 'Publish',
  description,
  actions: [],
  createdAt: '2026-11-03T00:00:00.000Z',
  resolvedAt: '2026-11-03T00:01:00.000Z',
  resolvedAction: 'hold',
  selectionData: { packageId: description },
  context: { receiptId: 'retained-receipt' },
});

test(
  'decision replacements retain whole rows and duplicate occurrences on disk',
  { timeout: 4000 },
  async (t) => {
    const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'HISTORY' });
    t.after(() => deleteTestRunIfPresent(run.id));
    const first = row('first');
    const second = row('second');
    const original = structuredClone([first, second, first]);
    updateRun(run.id, { decisions: [first, second, first] });
    updateRun(run.id, { decisions: [structuredClone(second)] });
    assert.deepEqual(getRun(run.id)!.decisionHistory, [original[0], original[2]]);
    const updated = { ...second, description: 'updated readiness' };
    updateRun(run.id, { decisions: [updated] });
    assert.deepEqual(getRun(run.id)!.decisionHistory, [original[0], original[2]]);
    first.description = 'changed outside the store';
    updateRun(run.id, { decisions: [] });
    updateRun(run.id, { decisions: [] });
    const history = [original[0], original[2], updated];
    assert.deepEqual(getRun(run.id)!.decisionHistory, history);
    await persistRunNow(getRun(run.id)!);
    const persisted = JSON.parse(
      await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
    );
    assert.deepEqual(persisted.decisions, []);
    assert.deepEqual(persisted.decisionHistory, history);
  },
);

test('a stale patch cannot replace or clear decision history', { timeout: 4000 }, async (t) => {
  const run = createRun({ flowType: 'dev', project: 'example-history', ticketOrPr: 'APPEND' });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { decisions: [row('retained')] });
  updateRun(run.id, { decisions: [] });
  const before = structuredClone(getRun(run.id));
  for (const decisionHistory of [[], undefined, [row('replacement')]]) {
    assert.throws(() => updateRun(run.id, { decisionHistory }), {
      message: 'Decision history is managed by the run store and cannot be replaced',
    });
    assert.deepEqual(getRun(run.id), before);
  }
});

for (const archived of [false, true]) {
  test(
    `publication commits retain decisions in ${archived ? 'archived' : 'live'} run records`,
    { timeout: 4000 },
    async (t) => {
      const run = createRun({
        flowType: 'dev',
        project: 'example-history',
        ticketOrPr: 'PROJ-351',
      });
      t.after(async () => {
        if (getRun(run.id)) await deleteTestRunIfPresent(run.id);
        else await deleteArchivedRun(run.id);
      });
      const original = row('publication');
      updateRun(run.id, { status: 'cancelled', decisions: [original] });
      if (archived) assert.equal(await archiveRun(run.id), true);
      await commitRunPublication(run.id, (current) => ({
        prNumber: 351,
        links: current.links,
        prPublications: current.prPublications,
        decisions: [],
      }));
      const retained = await getRunWithArchived(run.id);
      assert.deepEqual(retained?.decisions, []);
      assert.deepEqual(retained?.decisionHistory, [original]);
    },
  );
}

test('a run with only decision history is not a synthetic leak', () => {
  const run = buildRunRecord({
    flowType: 'dev',
    project: 'example-history',
    ticketOrPr: 'PROJ-351',
  });
  run.status = 'done';
  run.metrics.runner = null;
  run.completedAt = run.createdAt;
  run.decisionHistory = [row('audit')];
  assert.equal(isSyntheticLeak(run), false);
});
