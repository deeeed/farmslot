import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { validateTicketRef } from '../methods/dispatch/ticket-ref.js';

const testDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-backlog-test-'));
process.env.FARMSLOT_BACKLOG_FILE = path.join(testDir, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(testDir, 'queue.json');

test.after(() => rm(testDir, { recursive: true, force: true }));

async function freshStores() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await rm(process.env.FARMSLOT_BACKLOG_FILE!, { force: true });
  await rm(process.env.FARMSLOT_DISPATCH_QUEUE_FILE!, { force: true });
  const backlog = await import('./store.js');
  const queue = await import('./dispatch-queue.js');
  const dispatch = await import('../methods/dispatch/index.js');
  const runStore = await import('../runs/store.js');
  backlog.initBacklogStore(() => {});
  queue.initDispatchQueue(
    () => {},
    async () => {},
  );
  await queue.loadQueue();
  await backlog.loadBacklog();
  return { backlog, queue, dispatch, runStore };
}

test('backlog store creates manual items and enqueues with manual ticketData', async () => {
  const { backlog } = await freshStores();

  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Investigate local backlog idea',
    sourceKind: 'manual',
    flowType: 'dev',
    notes: 'Turn rough operator context into a concrete task.',
    priority: 7,
  });
  assert.equal(created.item.sourceRef, 'MANUAL-000001');
  assert.equal(created.item.status, 'candidate');

  const ready = await backlog.markBacklogItemReady({ itemId: created.item.id });
  assert.equal(ready.item.status, 'ready');

  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.equal(enqueued.item.status, 'queued');
  assert.equal(enqueued.queueItem.backlogItemId, created.item.id);
  assert.equal(enqueued.queueItem.ticketOrPr, 'MANUAL-000001');
  assert.equal(enqueued.queueItem.ticketData?.source, 'manual');
  assert.match(enqueued.queueItem.initialContext ?? '', /Backlog notes/);
});

test('backlog store allocates unique manual refs under concurrent creates', async () => {
  const { backlog } = await freshStores();

  const results = await Promise.all([
    backlog.createBacklogItem({
      project: 'farmslot',
      title: 'Concurrent idea A',
      sourceKind: 'manual',
      flowType: 'dev',
    }),
    backlog.createBacklogItem({
      project: 'farmslot',
      title: 'Concurrent idea B',
      sourceKind: 'manual',
      flowType: 'dev',
    }),
  ]);

  const refs = results.map((result) => result.item.sourceRef).sort();
  assert.deepEqual(refs, ['MANUAL-000001', 'MANUAL-000002']);
});

test('backlog store serializes concurrent enqueue for the same item', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Only enqueue once',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });

  const results = await Promise.allSettled([
    backlog.enqueueBacklogItem({ itemId: created.item.id }),
    backlog.enqueueBacklogItem({ itemId: created.item.id }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.ok(
    queue.getQueueSnapshot().filter((item) => item.backlogItemId === created.item.id).length <= 1,
  );
  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.ok(item && ['queued', 'dispatching', 'running'].includes(item.status));
  assert.equal(item?.lastDispatchError, undefined);
});

test('manual backlog enqueue rejects invalid allowedSlots before queueing', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Invalid isolated slot',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    allowedSlots: ['no-such-slot'],
  });

  await assert.rejects(
    () => backlog.enqueueBacklogItem({ itemId: created.item.id }),
    /allowed slot not found: no-such-slot/,
  );

  assert.equal(
    queue.getQueueSnapshot().filter((item) => item.backlogItemId === created.item.id).length,
    0,
  );
  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'ready');
  assert.match(item?.lastDispatchError ?? '', /allowed slot not found/);
});

test('backlog auto-dispatch reports guardrail blocks instead of enqueueing unsafe ready items', async () => {
  const { backlog } = await freshStores();

  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Auto dispatch requires guardrails',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    autoDispatch: true,
  });

  const result = await backlog.autoDispatchBacklogReady({ project: 'farmslot' });
  assert.equal(result.enqueued.length, 0);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0]?.item.id, created.item.id);
  assert.match(result.blocked[0]?.reason ?? '', /auto-dispatch|allowedSlots/);
});

test('backlog load reconciles existing queue item to prevent duplicate enqueue after restart', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Reconnect queued backlog item',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  await backlog.flushBacklogForTests();
  const queueItem = queue.addItem({
    backlogItemId: created.item.id,
    flowType: 'dev',
    project: 'farmslot',
    ticketOrPr: created.item.sourceRef,
    allowedSlots: ['no-such-slot'],
    priority: 10,
  });

  await backlog.loadBacklog();
  const reconciled = backlog
    .listBacklogItems({ includeArchived: true })
    .items.find((item) => item.id === created.item.id);
  assert.equal(reconciled?.status, 'queued');
  assert.equal(reconciled?.queuedQueueItemId, queueItem.id);
});

test('direct queue remove refuses backlog-linked queue items', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Cannot strand backlog queue link',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const queueItem = queue.addItem({
    backlogItemId: created.item.id,
    flowType: 'dev',
    project: 'farmslot',
    ticketOrPr: created.item.sourceRef,
    allowedSlots: ['no-such-slot'],
    priority: 10,
  });

  assert.throws(
    () => queue.removeItem(queueItem.id),
    /Cannot remove backlog-linked queue item directly/,
  );
});

test('public dispatch queue add rejects backlog handoff metadata', async () => {
  const { dispatch } = await freshStores();
  await assert.rejects(
    () =>
      dispatch.dispatchQueueAdd({
        flowType: 'dev',
        project: 'farmslot',
        ticketOrPr: 'MANUAL-000001',
        backlogItemId: 'backlog-1',
        ticketData: {
          source: 'manual',
          title: 'x',
          description: 'x',
          acceptanceCriteria: [],
          affectedArea: '',
          stepsToReproduce: [],
          screenshots: [],
          labels: [],
        },
      } as never),
    /cannot accept backlog handoff metadata/,
  );
});

test('direct ticket validation still rejects manual backlog refs without backlog handoff ticketData', () => {
  assert.throws(() => validateTicketRef('MANUAL-000001', 'dev'), /Invalid ticket reference/);
});

test('backlog load marks missing queue link needs-attention and clears stale queue id', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Stale queue link',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.queuedQueueItemId = 'missing-queue-item';
  created.item.status = 'queued';
  await backlog.flushBacklogForTests();

  await backlog.loadBacklog();
  const reconciled = backlog
    .listBacklogItems({ includeArchived: true })
    .items.find((item) => item.id === created.item.id);
  assert.equal(reconciled?.status, 'needs-attention');
  assert.equal(reconciled?.queuedQueueItemId, undefined);
});

test('backlog load rejects corrupted files without overwriting them', async () => {
  const { backlog } = await freshStores();
  await writeFile(process.env.FARMSLOT_BACKLOG_FILE!, '{not-json', 'utf-8');

  await assert.rejects(() => backlog.loadBacklog(), /failed to load backlog/);
  assert.equal(await readFile(process.env.FARMSLOT_BACKLOG_FILE!, 'utf-8'), '{not-json');
});

test('backlog.update rejects public lifecycle and run linkage mutation', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'No lifecycle forgery',
    sourceKind: 'manual',
    flowType: 'dev',
  });

  await assert.rejects(
    () =>
      backlog.updateBacklogItem({
        itemId: created.item.id,
        status: 'queued',
      } as never),
    /cannot mutate lifecycle/,
  );
});

test('explicit archived filter includes archived backlog items', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Archived view',
    sourceKind: 'manual',
    flowType: 'dev',
  });
  created.item.status = 'archived';

  assert.equal(backlog.listBacklogItems({ status: 'archived' }).items.length, 1);
  assert.equal(backlog.listBacklogItems().items.length, 0);
});

test('delete allows backlog items linked only to terminal runs', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Delete completed backlog item',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const run = runStore.createRun({
    flowType: 'dev',
    project: 'farmslot',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
  });
  runStore.updateRun(run.id, { status: 'done' });
  created.item.status = 'done';
  created.item.runId = run.id;
  created.item.queuedQueueItemId = 'stale-queue-link';

  await backlog.deleteBacklogItem(created.item.id);

  assert.equal(
    backlog
      .listBacklogItems({ includeArchived: true })
      .items.some((item) => item.id === created.item.id),
    false,
  );
});

test('manual backlog run handoff normalizes manual refs', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Normalize manual handoff',
    sourceKind: 'manual',
    sourceRef: 'manual-1',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'queued';

  assert.equal(
    backlog.isValidManualBacklogRunHandoff(created.item.id, 'manual-000001', 'farmslot'),
    true,
  );
  assert.equal(
    backlog.isValidManualBacklogRunHandoff(created.item.id, 'manual-000001', 'other-project'),
    false,
  );
});

test('run observation does not overwrite terminal backlog status', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Terminal status',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'done';
  created.item.runId = 'run-terminal';

  backlog.markBacklogRunObserved({
    id: 'run-terminal',
    status: 'failed',
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'done');
  assert.equal(item?.lastObservedRunStatus, undefined);
});

test('run observation can follow successor run by backlogItemId after parent cancellation', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Follow forked run',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'running';
  created.item.runId = 'parent-run';

  backlog.markBacklogRunObserved({
    id: 'parent-run',
    status: 'cancelled',
    backlogItemId: created.item.id,
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 25));
  backlog.markBacklogRunObserved({
    id: 'successor-run',
    status: 'done',
    backlogItemId: created.item.id,
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'done');
  assert.equal(item?.runId, 'successor-run');
});

test('backlog broadcasts include archived items for client-side archived filter', async () => {
  const { backlog } = await freshStores();
  let payload: unknown;
  backlog.initBacklogStore((_event, nextPayload) => {
    payload = nextPayload;
  });
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Broadcast archived view',
    sourceKind: 'manual',
    flowType: 'dev',
  });
  created.item.status = 'archived';
  await backlog.updateBacklogItem({ itemId: created.item.id, notes: 'touch' });

  assert.equal((payload as { items?: Array<{ id: string }> }).items?.[0]?.id, created.item.id);
});

test('backlog load does not overwrite terminal status from linked run observation', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot',
    title: 'Terminal status survives load',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const run = runStore.createRun({
    flowType: 'dev',
    project: 'farmslot',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
  });
  runStore.updateRun(run.id, { status: 'failed' });
  created.item.status = 'done';
  created.item.runId = run.id;
  await backlog.flushBacklogForTests();

  await backlog.loadBacklog();

  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'done');
  assert.equal(item?.lastObservedRunStatus, undefined);
});
