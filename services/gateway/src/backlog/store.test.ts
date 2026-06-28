import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { validateTicketRef } from '../methods/dispatch/ticket-ref.js';
import { farmslotRoot } from '../projects/repo-root.js';

const testDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-backlog-test-'));
const specRoot = path.join(farmslotRoot, '.sandbox', `backlog-spec-test-${process.pid}`);
process.env.FARMSLOT_BACKLOG_FILE = path.join(testDir, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(testDir, 'queue.json');
process.env.FARMSLOT_BACKLOG_SPEC_DIR = specRoot;

test.after(() =>
  Promise.all([
    rm(testDir, { recursive: true, force: true }),
    rm(specRoot, { recursive: true, force: true }),
  ]),
);

async function writeSpec(name: string, markdown: string): Promise<string> {
  await mkdir(specRoot, { recursive: true });
  const absolutePath = path.join(specRoot, name);
  await writeFile(absolutePath, markdown, 'utf-8');
  return path.relative(farmslotRoot, absolutePath);
}

async function freshStores() {
  const backlog = await import('./store.js');
  const queue = await import('./dispatch-queue.js');
  const dispatch = await import('../methods/dispatch/index.js');
  const runStore = await import('../runs/store.js');
  await backlog.flushBacklogForTests();
  await queue.persistQueueNow();
  await rm(process.env.FARMSLOT_BACKLOG_FILE!, { force: true });
  await rm(process.env.FARMSLOT_DISPATCH_QUEUE_FILE!, { force: true });
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
    project: 'farmslot-farm',
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

test('markdown-backed backlog specs require acceptance criteria before ready', async () => {
  const { backlog } = await freshStores();
  const specPath = await writeSpec(
    'missing-ac.md',
    '# Missing AC\n\n## Problem\n\nThis spec is not dispatchable yet.\n',
  );
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Missing AC spec',
    sourceKind: 'manual',
    flowType: 'dev',
    specPath,
  });

  await assert.rejects(
    () => backlog.markBacklogItemReady({ itemId: created.item.id }),
    /## Acceptance Criteria/,
  );
  assert.equal(backlog.listBacklogItems({ includeArchived: true }).items[0]?.status, 'candidate');
});

test('markdown-backed backlog specs must stay within configured spec root', async () => {
  const { backlog } = await freshStores();
  const outsidePath = path.join(testDir, 'outside-spec.md');
  await writeFile(
    outsidePath,
    '# Outside spec\n\n## Acceptance Criteria\n\n- Must not be readable as a backlog spec.\n',
    'utf-8',
  );

  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Outside spec',
    sourceKind: 'manual',
    flowType: 'dev',
    specPath: path.relative(farmslotRoot, outsidePath),
  });

  await assert.rejects(
    () => backlog.markBacklogItemReady({ itemId: created.item.id }),
    /configured backlog spec directory/,
  );
});

test('markdown-backed backlog specs enqueue spec text, ACs, and normalized tags', async () => {
  const { backlog, runStore } = await freshStores();
  const specPath = await writeSpec(
    'dispatchable.md',
    [
      '# Dispatchable spec',
      '',
      '## Context',
      '',
      'Build the markdown-backed backlog handoff.',
      '',
      '## Acceptance Criteria',
      '',
      '- AC one',
      '- AC two',
      '',
      '## Dispatch Notes',
      '',
      'Use the existing backlog queue.',
    ].join('\n'),
  );
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Dispatchable markdown spec',
    sourceKind: 'manual',
    flowType: 'dev',
    specPath,
    roadmapItemId: 'ri_spec123',
    tags: [' Roadmap ', '#Command Center', 'roadmap'],
    status: 'ready',
  });

  assert.deepEqual(created.item.tags, ['command-center', 'roadmap']);
  assert.equal(created.item.roadmapItemId, 'ri_spec123');
  assert.equal(backlog.listBacklogItems({ tags: ['command center'] }).items.length, 1);

  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.deepEqual(enqueued.queueItem.tags, ['command-center', 'roadmap']);
  assert.match(enqueued.queueItem.initialContext ?? '', /Backlog markdown spec/);
  assert.match(
    enqueued.queueItem.initialContext ?? '',
    /Build the markdown-backed backlog handoff/,
  );
  assert.deepEqual(enqueued.queueItem.ticketData?.acceptanceCriteria, ['AC one', 'AC two']);
  assert.deepEqual(enqueued.queueItem.ticketData?.labels, ['backlog', 'command-center', 'roadmap']);
  const run = runStore.createRun({
    flowType: enqueued.queueItem.flowType,
    project: enqueued.queueItem.project,
    ticketOrPr: enqueued.queueItem.ticketOrPr,
    backlogItemId: enqueued.queueItem.backlogItemId,
    ticketData: enqueued.queueItem.ticketData,
    tags: enqueued.queueItem.tags,
  });
  assert.deepEqual(run.tags, ['command-center', 'roadmap']);
});

test('backlog store allocates unique manual refs under concurrent creates', async () => {
  const { backlog } = await freshStores();

  const results = await Promise.all([
    backlog.createBacklogItem({
      project: 'farmslot-farm',
      title: 'Concurrent idea A',
      sourceKind: 'manual',
      flowType: 'dev',
    }),
    backlog.createBacklogItem({
      project: 'farmslot-farm',
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
    project: 'farmslot-farm',
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
  const item = backlog
    .listBacklogItems({ includeArchived: true })
    .items.find((candidate) => candidate.id === created.item.id);
  assert.ok(item && ['queued', 'dispatching', 'running'].includes(item.status));
  assert.equal(item?.lastDispatchError, undefined);
});

test('manual backlog enqueue rejects invalid allowedSlots before queueing', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
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
    project: 'farmslot-farm',
    title: 'Auto dispatch requires guardrails',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    autoDispatch: true,
  });

  const result = await backlog.autoDispatchBacklogReady({ project: 'farmslot-farm' });
  assert.equal(result.enqueued.length, 0);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0]?.item.id, created.item.id);
  assert.match(result.blocked[0]?.reason ?? '', /auto-dispatch|allowedSlots/);
});

test('backlog load reconciles existing queue item to prevent duplicate enqueue after restart', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Reconnect queued backlog item',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  await backlog.flushBacklogForTests();
  const queueItem = queue.addItem({
    backlogItemId: created.item.id,
    flowType: 'dev',
    project: 'farmslot-farm',
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
    project: 'farmslot-farm',
    title: 'Cannot strand backlog queue link',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const queueItem = queue.addItem({
    backlogItemId: created.item.id,
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    allowedSlots: ['no-such-slot'],
    priority: 10,
  });

  assert.throws(
    () => queue.removeItem(queueItem.id),
    /Cannot remove backlog-linked queue item directly/,
  );
});

test('dispatch queue normalizes tags before persistence', async () => {
  const { queue } = await freshStores();

  const queueItem = queue.addItem({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'FS-123',
    tags: [' Roadmap ', '#Command Center', 'roadmap'],
    priority: 10,
  });

  assert.deepEqual(queueItem.tags, ['command-center', 'roadmap']);
  assert.deepEqual(queue.getQueueSnapshot()[0]?.tags, ['command-center', 'roadmap']);
});

test('public dispatch queue add rejects backlog handoff metadata', async () => {
  const { dispatch } = await freshStores();
  await assert.rejects(
    () =>
      dispatch.dispatchQueueAdd({
        flowType: 'dev',
        project: 'farmslot-farm',
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
    project: 'farmslot-farm',
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
    project: 'farmslot-farm',
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
    project: 'farmslot-farm',
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
    project: 'farmslot-farm',
    title: 'Delete completed backlog item',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const run = runStore.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
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
    project: 'farmslot-farm',
    title: 'Normalize manual handoff',
    sourceKind: 'manual',
    sourceRef: 'manual-1',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'queued';

  assert.equal(
    backlog.isValidManualBacklogRunHandoff(created.item.id, 'manual-000001', 'farmslot-farm'),
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
    project: 'farmslot-farm',
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
    project: 'farmslot-farm',
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
    project: 'farmslot-farm',
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
    project: 'farmslot-farm',
    title: 'Terminal status survives load',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const run = runStore.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
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
