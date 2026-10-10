import assert from 'node:assert/strict';
import test from 'node:test';

import { deleteTestRunIfPresent } from '../run-engine/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import { refreshPublishedEvidence } from './published-evidence-refresh.js';

test('published evidence refresh rejects unpublished, active and imported runs without reopening them', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-1',
    runner: 'scripted',
  });
  t.after(async () => deleteTestRunIfPresent(run.id));
  const events: string[] = [];
  const emit = (event: string) => events.push(event);
  await assert.rejects(refreshPublishedEvidence({ runId: run.id }, emit), /already published/);
  updateRun(run.id, {
    prNumber: 1,
    status: 'ci-watching',
    engineState: { publishGate: { publicationStatus: 'published_ready' } },
  });
  await assert.rejects(
    refreshPublishedEvidence({ runId: run.id }, emit),
    /Wait for the published run/,
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
  updateRun(run.id, { status: 'done', readOnly: true });
  await assert.rejects(refreshPublishedEvidence({ runId: run.id }, emit), /Imported runs/);
  assert.equal(getRun(run.id)?.status, 'done');
  assert.deepEqual(events, []);
});
