import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';

import { validateTicketRef } from '../methods/dispatch/ticket-ref.js';
import { farmslotRoot } from '../projects/repo-root.js';

const testDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-backlog-test-'));
const specRoot = path.join(farmslotRoot, '.sandbox', `backlog-spec-test-${process.pid}`);
process.env.FARMSLOT_BACKLOG_FILE = path.join(testDir, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(testDir, 'queue.json');
process.env.FARMSLOT_BACKLOG_SPEC_DIR = specRoot;

function testSlot(slot: string, project = 'farmslot-farm'): SlotStatus {
  return {
    slot,
    machine: 'test-machine',
    platform: 'cli',
    project,
    health: { ssh: 'OK', devserver: 'OK', device: 'OK', cdp: 'OK', fixtures: 'OK' },
    branch: 'main',
    session: slot,
    repo: '.',
    linkedWorktree: false,
    agent: 'idle',
    enabled: true,
    dispatchable: false,
    lifecycle: 'manual',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    currentRunId: null,
    currentFlowType: null,
    currentTicketOrPr: null,
    currentMode: null,
    currentFamilyId: null,
    currentLane: null,
    currentVariant: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    resourceRollup: 'none',
  };
}

function testFleet(): FleetStatus {
  const slots = [testSlot('macwork-ff-1'), testSlot('macwork-ff-2'), testSlot('macwork-ff-3')];
  return {
    checkedAt: '2026-01-01T00:00:00.000Z',
    slots,
    summary: {
      total: slots.length,
      ready: 0,
      busy: 0,
      held: 0,
      manual: slots.length,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  };
}

test.after(async () => {
  const backlog = await import('./store.js');
  const queue = await import('./dispatch-queue.js');
  await backlog.flushBacklogForTests();
  await queue.persistQueueNow();
  await Promise.all([
    rm(testDir, { recursive: true, force: true }),
    rm(specRoot, { recursive: true, force: true }),
  ]);
});

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
  const fleetState = await import('../fleet/state.js');
  const runStore = await import('../runs/store.js');
  fleetState.setCachedFleetForTests(testFleet());
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

test('launch plan queues baseline first and materializes comparison candidates idempotently', async () => {
  const { backlog, queue, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Compare model variants',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_compare',
      version: 1,
      candidates: [
        {
          id: 'baseline',
          role: 'baseline',
          runner: 'claude',
          model: 'opus',
          slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
        },
        {
          id: 'sonnet',
          role: 'comparison',
          runner: 'claude',
          model: 'sonnet',
          variant: 'claude-sonnet',
          slotPolicy: { kind: 'pool', allowedSlots: ['macwork-ff-2', 'macwork-ff-3'] },
        },
        {
          id: 'codex',
          role: 'comparison',
          runner: 'codex',
          model: 'gpt-5.5',
          variant: 'codex-gpt-55',
          slotPolicy: { kind: 'spread', allowedSlots: ['macwork-ff-1', 'macwork-ff-2'] },
        },
      ],
    },
  });

  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.equal(enqueued.queueItem.launchPlanId, 'lp_compare');
  assert.equal(enqueued.queueItem.launchCandidateId, 'baseline');
  assert.equal(enqueued.queueItem.launchSlotPolicy, 'exact');
  assert.equal(enqueued.queueItem.slotId, 'macwork-ff-1');
  assert.deepEqual(enqueued.queueItem.allowedSlots, ['macwork-ff-1']);
  assert.equal(
    queue.getQueueSnapshot().filter((item) => item.backlogItemId === created.item.id).length,
    1,
  );

  const baselineRun = runStore.createRun({
    flowType: enqueued.queueItem.flowType,
    project: enqueued.queueItem.project,
    ticketOrPr: enqueued.queueItem.ticketOrPr,
    backlogItemId: enqueued.queueItem.backlogItemId,
    launchPlanId: enqueued.queueItem.launchPlanId,
    launchCandidateId: enqueued.queueItem.launchCandidateId,
    launchGroupId: enqueued.queueItem.launchGroupId,
    launchSlotPolicy: enqueued.queueItem.launchSlotPolicy,
    runner: enqueued.queueItem.runner,
    model: enqueued.queueItem.model,
    slotId: enqueued.queueItem.slotId,
  });

  await backlog.markBacklogRunStarted(enqueued.queueItem, baselineRun);
  await backlog.markBacklogRunStarted(enqueued.queueItem, baselineRun);

  const queued = queue
    .getQueueSnapshot()
    .filter((item) => item.backlogItemId === created.item.id)
    .sort((a, b) => (a.launchCandidateId ?? '').localeCompare(b.launchCandidateId ?? ''));
  assert.equal(queued.length, 3);
  const sonnet = queued.find((item) => item.launchCandidateId === 'sonnet');
  assert.equal(sonnet?.lane, 'comparison');
  assert.equal(sonnet?.familyId, baselineRun.familyId);
  assert.equal(sonnet?.parentRunId, baselineRun.id);
  assert.equal(sonnet?.variant, 'claude-sonnet');
  assert.deepEqual(sonnet?.allowedSlots, ['macwork-ff-2', 'macwork-ff-3']);
  const codex = queued.find((item) => item.launchCandidateId === 'codex');
  assert.equal(codex?.launchSlotPolicy, 'spread');
  assert.deepEqual(codex?.allowedSlots, ['macwork-ff-1', 'macwork-ff-2']);
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
    /Cannot remove backlog-linked queue item directly; use backlog\.dequeue/,
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
  await assert.rejects(
    () =>
      dispatch.dispatchQueueAdd({
        flowType: 'dev',
        project: 'farmslot-farm',
        ticketOrPr: 'FS-123',
        launchPlanId: 'lp_1',
        launchCandidateId: 'baseline',
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

test('deleted run releases failed backlog item back to ready', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Retry after delete',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'failed';
  created.item.runId = 'deleted-run';
  created.item.lastObservedRunStatus = 'failed';

  const graphIds = await backlog.markBacklogRunDeleted('deleted-run');
  assert.deepEqual(graphIds, []);

  const item = backlog.listBacklogItems().items[0];
  assert.equal(item?.status, 'ready');
  assert.equal(item?.runId, undefined);
  assert.equal(item?.lastObservedRunStatus, undefined);
});

test('mark ready clears stale run linkage for failed backlog items', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Manual retry',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'failed';
  created.item.runId = 'stale-run';
  created.item.lastObservedRunStatus = 'failed';

  const result = await backlog.markBacklogItemReady({ itemId: created.item.id });
  assert.equal(result.item.status, 'ready');
  assert.equal(result.item.runId, undefined);
  assert.equal(result.item.lastObservedRunStatus, undefined);
});

test('backlog load releases failed items with missing linked runs', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Orphan failed link',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'failed';
  created.item.runId = 'missing-run';
  created.item.lastObservedRunStatus = 'failed';
  await backlog.updateBacklogItem({ itemId: created.item.id, notes: 'persist failed link' });
  await backlog.flushBacklogForTests();

  await backlog.loadBacklog();
  const item = backlog.listBacklogItems().items[0];
  assert.equal(item?.status, 'ready');
  assert.equal(item?.runId, undefined);
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

test('backlog execution hints persist and propagate to queued dispatch', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Dispatch with hints',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    runner: ' codex ',
    model: 'gpt-5.5',
    effort: 'high',
  });

  assert.equal(created.item.runner, 'codex');
  assert.equal(created.item.model, 'gpt-5.5');
  assert.equal(created.item.effort, 'high');

  const updated = await backlog.updateBacklogItem({
    itemId: created.item.id,
    model: 'gpt-5.6',
    effort: null,
  });
  assert.equal(updated.item.model, 'gpt-5.6');
  assert.equal(updated.item.effort, undefined);

  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.equal(enqueued.queueItem.runner, 'codex');
  assert.equal(enqueued.queueItem.model, 'gpt-5.6');
  assert.equal(enqueued.queueItem.effort, undefined);
});

test('backlog rejects incompatible runner/model hints', async () => {
  const { backlog } = await freshStores();
  await assert.rejects(
    () =>
      backlog.createBacklogItem({
        project: 'farmslot-farm',
        title: 'Bad hints',
        sourceKind: 'manual',
        flowType: 'dev',
        runner: 'codex',
        model: 'opus',
      }),
    /not compatible/,
  );
});

test('backlog allows model-only hints until a runner is selected', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Model hint only',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    model: 'gpt-5.6',
  });

  assert.equal(created.item.runner, undefined);
  assert.equal(created.item.model, 'gpt-5.6');

  await assert.rejects(
    () => backlog.updateBacklogItem({ itemId: created.item.id, runner: 'claude' }),
    /not compatible/,
  );
});

test('backlog.dequeue removes linked queue items and returns item to ready', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Dequeue round trip',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    allowedSlots: ['macwork-ff-1'],
  });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.equal(enqueued.item.status, 'queued');
  assert.equal(queue.listItems().length, 1);

  const dequeued = await backlog.dequeueBacklogItem({ itemId: created.item.id });
  assert.equal(dequeued.item.status, 'ready');
  assert.equal(dequeued.item.queuedQueueItemId, undefined);
  assert.equal(dequeued.item.runId, undefined);
  assert.equal(queue.listItems().length, 0);

  const reEnqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.equal(reEnqueued.item.status, 'queued');
  assert.equal(queue.listItems().length, 1);
});

test('backlog.dequeue rejects non-queued items', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Not queued',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });

  await assert.rejects(
    () => backlog.dequeueBacklogItem({ itemId: created.item.id }),
    /Cannot dequeue backlog item in status ready/,
  );
});

test('backlog.dequeue rejects work-graph-linked items', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Graph-linked dequeue guard',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'queued';
  created.item.workGraphId = 'graph-1';
  created.item.workNodeId = 'node-1';

  await assert.rejects(
    () => backlog.dequeueBacklogItem({ itemId: created.item.id }),
    /linked to a work graph/,
  );
});

test('backlog.dequeue rejects items linked to active runs', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Active run dequeue guard',
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
  created.item.status = 'queued';
  created.item.runId = run.id;

  await assert.rejects(
    () => backlog.dequeueBacklogItem({ itemId: created.item.id }),
    /Cannot dequeue backlog item with active run/,
  );
});

test('backlog.dequeue rejects while linked queue item is dispatching', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Dispatching queue guard',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    allowedSlots: ['macwork-ff-1'],
  });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  const linked = queue.getQueueSnapshot().find((item) => item.id === enqueued.queueItem.id);
  assert.ok(linked);
  linked.status = 'dispatching';

  await assert.rejects(
    () => backlog.dequeueBacklogItem({ itemId: created.item.id }),
    /Cannot dequeue backlog item while dispatch is in progress/,
  );
});

test('backlog.dequeue purges cancelled linked queue rows before re-enqueue', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Cancelled queue row round trip',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    allowedSlots: ['macwork-ff-1'],
  });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  const linked = queue.getQueueSnapshot().find((item) => item.id === enqueued.queueItem.id);
  assert.ok(linked);
  linked.status = 'cancelled';
  await queue.persistQueueNow();

  const dequeued = await backlog.dequeueBacklogItem({ itemId: created.item.id });
  assert.equal(dequeued.item.status, 'ready');
  assert.equal(
    queue.getQueueSnapshot().filter((item) => item.backlogItemId === created.item.id).length,
    0,
  );

  const reEnqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.equal(reEnqueued.item.status, 'queued');
  assert.equal(reEnqueued.queueItem.status, 'queued');
  assert.equal(queue.listItems().length, 1);
});

test('backlog.dequeue clears stale baseline run linkage on launch-plan re-enqueue', async () => {
  const { backlog, queue, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Compare model variants',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_compare',
      version: 1,
      candidates: [
        {
          id: 'baseline',
          role: 'baseline',
          runner: 'claude',
          model: 'opus',
          slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
        },
        {
          id: 'sonnet',
          role: 'comparison',
          runner: 'claude',
          model: 'sonnet',
          variant: 'claude-sonnet',
          slotPolicy: { kind: 'pool', allowedSlots: ['macwork-ff-2'] },
        },
      ],
    },
  });

  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  const baselineRun = runStore.createRun({
    flowType: enqueued.queueItem.flowType,
    project: enqueued.queueItem.project,
    ticketOrPr: enqueued.queueItem.ticketOrPr,
    backlogItemId: enqueued.queueItem.backlogItemId,
    launchPlanId: enqueued.queueItem.launchPlanId,
    launchCandidateId: enqueued.queueItem.launchCandidateId,
    launchGroupId: enqueued.queueItem.launchGroupId,
    launchSlotPolicy: enqueued.queueItem.launchSlotPolicy,
    runner: enqueued.queueItem.runner,
    model: enqueued.queueItem.model,
    slotId: enqueued.queueItem.slotId,
  });
  await backlog.markBacklogRunStarted(enqueued.queueItem, baselineRun);
  runStore.updateRun(baselineRun.id, { status: 'done' });
  backlog.markBacklogRunObserved({ ...baselineRun, status: 'done' } as never);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const queuedItem = backlog
    .listBacklogItems({ includeArchived: true })
    .items.find((candidate) => candidate.id === created.item.id);
  assert.equal(queuedItem?.status, 'queued');
  assert.equal(queuedItem?.runId, baselineRun.id);
  assert.ok(
    queue.getQueueSnapshot().filter((item) => item.backlogItemId === created.item.id).length >= 2,
  );

  const dequeued = await backlog.dequeueBacklogItem({ itemId: created.item.id });
  assert.equal(dequeued.item.status, 'ready');
  assert.equal(dequeued.item.runId, undefined);
  assert.equal(dequeued.item.queuedQueueItemId, undefined);
  assert.equal(dequeued.item.launchPlanState?.baselineRunId, baselineRun.id);

  const reEnqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.equal(reEnqueued.item.status, 'queued');
  assert.ok(reEnqueued.queueItem);
});

test('loadBacklog keeps orphaned queue items until operator removes them', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Orphan cleanup',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  await rm(process.env.FARMSLOT_BACKLOG_FILE!, { force: true });
  await backlog.loadBacklog();
  assert.equal(backlog.listBacklogItems().items.length, 0);
  assert.equal(queue.listItems().length, 1);
  assert.equal(backlog.listOrphanedBacklogQueueItems().length, 1);
  assert.equal(
    queue.getQueueSnapshot().some((item) => item.id === enqueued.queueItem.id),
    true,
  );
});

test('dispatch.queue.removeOrphan rejects non-orphan backlog-linked queue items', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Non-orphan remove guard',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  await assert.rejects(
    () => backlog.removeOrphanBacklogQueueItem({ itemId: enqueued.queueItem.id }),
    /Cannot remove queue item as orphan/,
  );
});

test('dispatch.queue.removeOrphan removes orphaned backlog-linked queue items', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Orphan direct remove',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  await rm(process.env.FARMSLOT_BACKLOG_FILE!, { force: true });
  await backlog.loadBacklog();
  await backlog.removeOrphanBacklogQueueItem({ itemId: enqueued.queueItem.id });
  assert.equal(queue.listItems().length, 0);
});

test('dispatch.queue.removeOrphan removes cancelled orphaned backlog-linked queue items', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Cancelled orphan cleanup',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  const linked = queue.getQueueSnapshot().find((item) => item.id === enqueued.queueItem.id);
  assert.ok(linked);
  linked.status = 'cancelled';
  await queue.persistQueueNow();

  await rm(process.env.FARMSLOT_BACKLOG_FILE!, { force: true });
  await backlog.loadBacklog();
  assert.equal(backlog.listOrphanedBacklogQueueItems().length, 1);
  await backlog.removeOrphanBacklogQueueItem({ itemId: enqueued.queueItem.id });
  assert.equal(queue.getQueueSnapshot().length, 0);
});

test('dispatch.queue.removeOrphan refuses dispatching orphaned backlog-linked queue items', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Dispatching orphan guard',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  const linked = queue.getQueueSnapshot().find((item) => item.id === enqueued.queueItem.id);
  assert.ok(linked);
  linked.status = 'dispatching';
  await queue.persistQueueNow();

  await rm(process.env.FARMSLOT_BACKLOG_FILE!, { force: true });
  await backlog.loadBacklog();
  assert.equal(backlog.listOrphanedBacklogQueueItems().length, 0);
  await assert.rejects(
    () => backlog.removeOrphanBacklogQueueItem({ itemId: enqueued.queueItem.id }),
    /Cannot remove queue item as orphan/,
  );
});
