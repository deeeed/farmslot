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

test('source-selected run creation refuses missing or revoked source authority before registering', async () => {
  const before = getAllRuns().map((run) => run.id);
  const params = {
    project: 'farmslot-farm',
    flowType: 'dev',
    ticketOrPr: 'DEV-SOURCE-AUTH',
    sourceSelections: [{ sourceId: 'pack', selection: 'main' }],
  };
  const context = { emit: () => undefined, broadcast: () => undefined };
  await assert.rejects(
    routeRunMethod(Methods.RUN_CREATE, params, context),
    /authenticated routing/,
  );
  await assert.rejects(
    routeRunMethod(Methods.RUN_CREATE_NATIVE, params, {
      ...context,
      authorizeSourceSelections: () => {
        throw new Error('source permission revoked');
      },
    }),
    /permission revoked/,
  );
  assert.deepEqual(
    getAllRuns().map((run) => run.id),
    before,
  );
});

test('linked-ticket metadata persists and broadcasts without changing frozen inputs or execution', async () => {
  const run = createRun({
    project: 'farmslot-farm',
    flowType: 'dev',
    ticketOrPr: 'TEAM-100',
    ticketData: {
      source: 'manual',
      title: 'Original scope',
      description: '## TEAM-100',
      acceptanceCriteria: ['[TEAM-100] Original acceptance'],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  });
  const before = structuredClone(getRun(run.id)!);
  const broadcasts: EventFrame[] = [];
  const context = {
    emit: () => assert.fail('metadata must broadcast'),
    broadcast: (frame: EventFrame) => broadcasts.push(frame),
  };
  await routeRunMethod(
    Methods.RUN_LINKED_TICKETS_SET,
    { runId: run.id, linkedTicketRefs: [' team-200 ', 'TEAM-200'] },
    context,
  );
  const saved = getRun(run.id)!;
  assert.deepEqual(saved.linkedTicketRefs, ['TEAM-200']);
  for (const key of [
    'ticketData',
    'taskFile',
    'engineState',
    'steps',
    'decisions',
    'reviewRoundAdmissions',
    'status',
  ] as const)
    assert.deepEqual(saved[key], before[key]);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].event, Events.RUN_UPDATED);
  await persistRunNow(saved);
  assert.deepEqual(
    JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile((await import('../runs/store.js')).runRecordPath(run.id), 'utf8'),
    ).linkedTicketRefs,
    ['TEAM-200'],
  );
  await assert.rejects(
    routeRunMethod(
      Methods.RUN_LINKED_TICKETS_SET,
      { runId: run.id, linkedTicketRefs: ['bad'] },
      context,
    ),
    /Jira key/,
  );
  assert.deepEqual(getRun(run.id)?.linkedTicketRefs, ['TEAM-200']);
  assert.equal(broadcasts.length, 1);
  await routeRunMethod(
    Methods.RUN_LINKED_TICKETS_SET,
    { runId: run.id, linkedTicketRefs: [] },
    context,
  );
  assert.deepEqual(getRun(run.id)?.ticketData, before.ticketData);
});
