import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { type EventFrame, Events, Methods, type RunUpdatedPayload } from '@farmslot/protocol';

const runsDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-run-route-'));
process.env.FARMSLOT_RUNS_DIR = runsDir;
const { createRun, getAllRuns, getRun, loadAllRuns, persistRunNow, updateRun } =
  await import('../runs/store.js');
const { routeRunMethod } = await import('./run-route.js');
await loadAllRuns();
after(async () => {
  await Promise.all(getAllRuns().map((run) => persistRunNow(run)));
  rmSync(runsDir, { recursive: true, force: true });
});

test('finishing an interactive run broadcasts Done instead of notifying only the caller', async () => {
  const run = createRun({
    project: 'farmslot-farm',
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr: 'DEV-BROADCAST-DONE',
    prNumber: 35831,
  });
  updateRun(run.id, { status: 'ci-watching' });
  const broadcasts: EventFrame[] = [];
  const callerEvents: string[] = [];
  const result = await routeRunMethod(
    Methods.RUN_INTERACTIVE_DEV_RESOLVE,
    {
      runId: run.id,
      action: 'done-no-pr',
      reason: 'Development done; CI deferred until dependency release',
    },
    {
      emit: (event) => callerEvents.push(event),
      broadcast: (frame) => broadcasts.push(frame),
    },
  );
  assert.equal(result.handled, true);
  assert.equal(getRun(run.id)?.status, 'done');
  assert.equal(getRun(run.id)?.prNumber, 35831);
  const update = broadcasts.find((frame) => frame.event === Events.RUN_UPDATED)
    ?.payload as RunUpdatedPayload;
  assert.equal(update?.run?.id, run.id);
  assert.equal(update?.run?.status, 'done');
  assert.deepEqual(callerEvents, []);
});

test('metadata edits also broadcast the authoritative run to other clients', async () => {
  const run = createRun({
    project: 'farmslot-farm',
    flowType: 'dev',
    ticketOrPr: 'DEV-BROADCAST-TAGS',
  });
  const broadcasts: EventFrame[] = [];
  const callerEvents: string[] = [];
  await routeRunMethod(
    Methods.RUN_TAGS_SET,
    { runId: run.id, tags: ['deferred-ci'] },
    {
      emit: (event) => callerEvents.push(event),
      broadcast: (frame) => broadcasts.push(frame),
    },
  );
  const update = broadcasts.find((frame) => frame.event === Events.RUN_UPDATED)
    ?.payload as RunUpdatedPayload;
  assert.equal(update?.run?.id, run.id);
  assert.deepEqual(update?.run?.tags, ['deferred-ci']);
  assert.deepEqual(callerEvents, []);
});
