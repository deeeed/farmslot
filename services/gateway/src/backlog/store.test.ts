import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('markdown-backed backlog specs allow jira sourceKind when AC section is present', async () => {
  const { backlog } = await freshStores();
  const specPath = await writeSpec(
    'jira-with-spec.md',
    [
      '# Jira-tracked fix with Farmslot AC',
      '',
      '## Acceptance Criteria',
      '',
      '- Controller maps the failure to a stable error code',
      '- Regression test covers the recovery path',
    ].join('\n'),
  );
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Jira ticket with markdown AC',
    sourceKind: 'jira',
    sourceRef: 'TAT-78001',
    flowType: 'fix-bug',
    specPath,
  });
  assert.equal(created.item.sourceKind, 'jira');
  assert.equal(created.item.sourceRef, 'TAT-78001');
  assert.equal(created.item.specPath, specPath);

  const ready = await backlog.markBacklogItemReady({ itemId: created.item.id });
  assert.equal(ready.item.status, 'ready');

  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.equal(enqueued.item.status, 'queued');
  assert.equal(enqueued.queueItem.ticketOrPr, 'TAT-78001');
  // Jira items keep live ticket fetch; markdown is additive context only.
  assert.equal(enqueued.queueItem.ticketData, undefined);
  assert.match(enqueued.queueItem.initialContext ?? '', /Backlog markdown spec/);
  assert.match(enqueued.queueItem.initialContext ?? '', /stable error code/);
  assert.match(enqueued.queueItem.initialContext ?? '', /Backlog source: jira TAT-78001/);
});

test('markdown-backed backlog specs still reject jira items missing AC section', async () => {
  const { backlog } = await freshStores();
  const specPath = await writeSpec(
    'jira-missing-ac.md',
    '# Jira ticket\n\n## Problem\n\nNo AC yet.\n',
  );
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Jira ticket missing AC',
    sourceKind: 'jira',
    sourceRef: 'TAT-78002',
    flowType: 'fix-bug',
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
  // ACs render separately via {{ACCEPTANCE_CRITERIA}} — the description must
  // not duplicate the spec's AC section (its checkboxes skew step numbering).
  assert.doesNotMatch(enqueued.queueItem.ticketData?.description ?? '', /## Acceptance Criteria/);
  assert.match(enqueued.queueItem.ticketData?.description ?? '', /## Context/);
  assert.match(enqueued.queueItem.ticketData?.description ?? '', /## Dispatch Notes/);
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

test('backlog.archive moves finished backlog items to archived', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Archive completed backlog item',
    sourceKind: 'manual',
    flowType: 'dev',
  });
  created.item.status = 'done';

  const archived = await backlog.archiveBacklogItem({ itemId: created.item.id });
  assert.equal(archived.item.status, 'archived');
  assert.equal(backlog.listBacklogItems().items.length, 0);
  assert.equal(backlog.listBacklogItems({ status: 'archived' }).items.length, 1);
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

test('run observation heals needs-attention when linked run completes', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Blocked then done',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'needs-attention';
  created.item.runId = 'blocked-then-done';
  created.item.lastObservedRunStatus = 'blocked';

  await backlog.markBacklogRunObserved({
    id: 'blocked-then-done',
    status: 'done',
    backlogItemId: created.item.id,
  } as never);

  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'done');
  assert.equal(item?.lastObservedRunStatus, 'done');
});

test('multi-PR item returns to ready on run done instead of auto-closing', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Multi-slice shrink',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    multiPr: true,
  });
  created.item.status = 'running';
  created.item.runId = 'slice-1-run';

  await backlog.markBacklogRunObserved({
    id: 'slice-1-run',
    status: 'done',
    backlogItemId: created.item.id,
  } as never);

  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'ready'); // next slice dispatchable, not closed
  assert.equal(item?.lastObservedRunStatus, 'done');
  assert.equal(item?.runId, undefined); // run link cleared so enqueue accepts the next slice

  // Never auto-dispatchable — that would loop the same spec every slice...
  await assert.rejects(
    () => backlog.enqueueBacklogItem({ itemId: created.item.id, auto: true }),
    /multi-PR items require explicit enqueue/,
  );
  // ...but genuinely enqueueable for the next slice by explicit operator action.
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.equal(enqueued.item.status, 'queued');

  // Failure/needs-attention paths keep their normal behavior on multi-PR items
  // once the next slice's run is actually linked (queue -> run handoff).
  const queuedItem = backlog.listBacklogItems({ includeArchived: true }).items[0]!;
  delete queuedItem.queuedQueueItemId;
  queuedItem.status = 'running';
  queuedItem.runId = 'slice-2-run';
  await backlog.markBacklogRunObserved({
    id: 'slice-2-run',
    status: 'failed',
    backlogItemId: created.item.id,
  } as never);
  assert.equal(backlog.listBacklogItems({ includeArchived: true }).items[0]?.status, 'failed');
});

test('late completion echo from a previous slice cannot clobber the next slice', async () => {
  const { backlog, queue, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Slice echo guard',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    multiPr: true,
  });
  const sliceOne = runStore.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
  });
  runStore.updateRun(sliceOne.id, { status: 'done' });
  created.item.status = 'running';
  created.item.runId = sliceOne.id;
  await backlog.markBacklogRunObserved({ ...sliceOne, status: 'done' } as never);
  assert.equal(backlog.listBacklogItems({ includeArchived: true }).items[0]?.status, 'ready');

  // Slice 2 queued: a late RUN_UPDATED echo from slice 1 must not clear the queue link.
  const queueItem = queue.addItem({
    backlogItemId: created.item.id,
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    allowedSlots: ['no-such-slot'],
    priority: 10,
  });
  created.item.status = 'queued';
  created.item.queuedQueueItemId = queueItem.id;
  await backlog.markBacklogRunObserved({ ...sliceOne, status: 'done' } as never);
  let item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'queued');
  assert.equal(item?.queuedQueueItemId, queueItem.id);

  // Slice 2 running: the echo must not reset the item or steal the run link.
  const sliceTwo = runStore.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
  });
  runStore.updateRun(sliceTwo.id, { status: 'monitoring' });
  delete created.item.queuedQueueItemId;
  created.item.status = 'running';
  created.item.runId = sliceTwo.id;
  await backlog.markBacklogRunObserved({ ...sliceOne, status: 'done' } as never);
  item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'running');
  assert.equal(item?.runId, sliceTwo.id);

  // Slice 2 finishing still applies normally.
  await backlog.markBacklogRunObserved({ ...sliceTwo, status: 'done' } as never);
  item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'ready');
  assert.equal(item?.runId, undefined);
});

test('a late prior-slice done echo does not resurrect a failed multi-PR slice', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Failed slice echo guard',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    multiPr: true,
  });
  // Slice 1 completed (its run is terminal, item moved on).
  const sliceOne = runStore.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
  });
  runStore.updateRun(sliceOne.id, { status: 'done' });
  // Slice 2 is linked and has FAILED (item.runId points at a terminal run).
  const sliceTwo = runStore.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
  });
  runStore.updateRun(sliceTwo.id, { status: 'failed' });
  created.item.status = 'failed';
  created.item.runId = sliceTwo.id;

  // A late slice-1 done echo must NOT reset the failed item to ready or clear
  // slice 2's link, even though slice 2's run is terminal.
  await backlog.markBacklogRunObserved({ ...sliceOne, status: 'done' } as never);
  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'failed');
  assert.equal(item?.runId, sliceTwo.id);
});

test('multiPr cannot be combined with work-graph linkage', async () => {
  const { backlog } = await freshStores();
  // Attaching a graph node to a multi-PR item is rejected.
  const multi = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Graph combo attach',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'candidate',
    multiPr: true,
  });
  await assert.rejects(
    () =>
      backlog.attachBacklogItemToWorkNode({
        itemId: multi.item.id,
        graphId: 'wg_1',
        nodeId: 'node_1',
      }),
    /cannot attach a multi-PR backlog item to a work-graph node/,
  );

  // Marking an already graph-linked item multiPr is rejected too.
  const graphLinked = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Graph combo update',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'candidate',
  });
  await backlog.attachBacklogItemToWorkNode({
    itemId: graphLinked.item.id,
    graphId: 'wg_2',
    nodeId: 'node_2',
  });
  await assert.rejects(
    () => backlog.updateBacklogItem({ itemId: graphLinked.item.id, multiPr: true }),
    /multiPr cannot be combined with work-graph linkage/,
  );
});

test('launch-plan observation from a foreign plan is ignored', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Foreign plan echo',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_real',
      version: 1,
      candidates: [
        {
          id: 'baseline',
          role: 'baseline',
          runner: 'claude',
          model: 'opus',
          slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
        },
      ],
    },
  });
  const baselineRun = runStore.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
    launchPlanId: 'lp_real',
    launchCandidateId: 'baseline',
  });
  runStore.updateRun(baselineRun.id, { status: 'monitoring' });
  await backlog.markBacklogRunObserved({ ...baselineRun, status: 'monitoring' } as never);
  assert.equal(backlog.listBacklogItems({ includeArchived: true }).items[0]?.runId, baselineRun.id);

  // Observation tagged with a DIFFERENT plan id (and a candidate id not in this
  // plan) must neither inject a projection nor steal the baseline link.
  await backlog.markBacklogRunObserved({
    id: 'foreign-run',
    status: 'done',
    backlogItemId: created.item.id,
    launchPlanId: 'lp_other',
    launchCandidateId: 'baseline',
  } as never);
  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.runId, baselineRun.id);
  assert.equal(item?.launchPlanState?.candidates.length ?? 0, 1);
});

test('a stale candidate echo cannot overwrite the projection owned by a newer-attempt run', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Stale candidate echo',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_stale',
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
  const mkRun = (candidate: string, launchAttempt: number, status: string) => {
    const run = runStore.createRun({
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: created.item.sourceRef,
      backlogItemId: created.item.id,
      launchPlanId: 'lp_stale',
      launchCandidateId: candidate,
      launchAttempt,
    } as never);
    return runStore.updateRun(run.id, { status } as never);
  };
  // Live baseline keeps the item non-terminal so candidate events reach the guard.
  await backlog.markBacklogRunObserved({ ...mkRun('baseline', 1, 'monitoring') } as never);

  // Newer-attempt sonnet run owns the projection (attempt 2).
  const newerSonnet = mkRun('sonnet', 2, 'done');
  await backlog.markBacklogRunObserved({ ...newerSonnet } as never);
  const sonnetProjection = () =>
    backlog
      .listBacklogItems({ includeArchived: true })
      .items[0]?.launchPlanState?.candidates.find((c) => c.candidateId === 'sonnet');
  assert.equal(sonnetProjection()?.runId, newerSonnet.id);
  assert.equal(sonnetProjection()?.attempt, 2);

  // An older-attempt sonnet run re-emits a late echo — dropped as stale (attempt 1 < 2).
  await backlog.markBacklogRunObserved({ ...mkRun('sonnet', 1, 'failed') } as never);
  assert.equal(sonnetProjection()?.runId, newerSonnet.id);
  assert.equal(sonnetProjection()?.status, 'succeeded');
});

test('a newer-attempt re-enqueued run takes over from an older running owner', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Candidate re-enqueue takeover',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_retry',
      version: 1,
      candidates: [
        {
          id: 'baseline',
          role: 'baseline',
          runner: 'claude',
          model: 'opus',
          slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
        },
      ],
    },
  });
  const mkRun = (launchAttempt: number, status: string) => {
    const run = runStore.createRun({
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: created.item.sourceRef,
      backlogItemId: created.item.id,
      launchPlanId: 'lp_retry',
      launchCandidateId: 'baseline',
      launchAttempt,
    } as never);
    return runStore.updateRun(run.id, { status } as never);
  };
  // First baseline run (attempt 1) is live and owns the item link.
  const firstBaseline = mkRun(1, 'monitoring');
  await backlog.markBacklogRunObserved({ ...firstBaseline } as never);
  assert.equal(
    backlog.listBacklogItems({ includeArchived: true }).items[0]?.runId,
    firstBaseline.id,
  );

  // A re-enqueued higher-attempt baseline run's first update arrives before its
  // markBacklogRunStarted ownership transfer — it must take over, not be stranded
  // (the strict identity rule stranded this; wall-clock recency could tie on it).
  const retryBaseline = mkRun(2, 'monitoring');
  await backlog.markBacklogRunObserved({ ...retryBaseline } as never);
  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.runId, retryBaseline.id);
  assert.equal(item?.launchPlanState?.baselineRunId, retryBaseline.id);
  assert.equal(
    item?.launchPlanState?.candidates.find((c) => c.candidateId === 'baseline')?.attempt,
    2,
  );
});

test('a foreign baseline echo cannot steal the item run link from a live baseline', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Baseline steal guard',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_base',
      version: 1,
      candidates: [
        {
          id: 'baseline',
          role: 'baseline',
          runner: 'claude',
          model: 'opus',
          slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
        },
      ],
    },
  });
  const mkRun = (launchAttempt: number, status: string) => {
    const run = runStore.createRun({
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: created.item.sourceRef,
      backlogItemId: created.item.id,
      launchPlanId: 'lp_base',
      launchCandidateId: 'baseline',
      launchAttempt,
    } as never);
    return runStore.updateRun(run.id, { status } as never);
  };
  const liveBaseline = mkRun(2, 'monitoring');
  await backlog.markBacklogRunObserved({ ...liveBaseline } as never);
  assert.equal(
    backlog.listBacklogItems({ includeArchived: true }).items[0]?.runId,
    liveBaseline.id,
  );

  // An older-attempt run reusing the baseline candidate id must not reassign
  // item.runId while the newer live baseline owns it.
  const foreignBaseline = mkRun(1, 'done');
  await backlog.markBacklogRunObserved({ ...foreignBaseline } as never);
  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.runId, liveBaseline.id);
  assert.equal(item?.launchPlanState?.baselineRunId, liveBaseline.id);
});

test('candidate attempt survives persistence and reload', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Attempt persistence',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_persist',
      version: 1,
      candidates: [
        {
          id: 'baseline',
          role: 'baseline',
          runner: 'claude',
          model: 'opus',
          slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
        },
      ],
    },
  });
  const run = runStore.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
    launchPlanId: 'lp_persist',
    launchCandidateId: 'baseline',
    launchAttempt: 3,
  } as never);
  runStore.updateRun(run.id, { status: 'monitoring' } as never);
  await backlog.markBacklogRunObserved({ ...run } as never);
  const attemptBefore = () =>
    backlog
      .listBacklogItems({ includeArchived: true })
      .items[0]?.launchPlanState?.candidates.find((c) => c.candidateId === 'baseline')?.attempt;
  assert.equal(attemptBefore(), 3);

  await backlog.flushBacklogForTests();
  await backlog.loadBacklog();
  const reloaded = backlog
    .listBacklogItems({ includeArchived: true })
    .items[0]?.launchPlanState?.candidates.find((c) => c.candidateId === 'baseline');
  assert.equal(reloaded?.attempt, 3); // counter must not regress on restart
});

test('restart drops a dispatching launch-candidate row whose run already exists', async () => {
  const { backlog, queue, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Restart reconcile',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_restart',
      version: 1,
      candidates: [
        {
          id: 'baseline',
          role: 'baseline',
          runner: 'claude',
          model: 'opus',
          slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
        },
      ],
    },
  });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  // Simulate gateway shutdown mid-handoff: row is 'dispatching' on disk and the
  // run it produced is durable with the SAME launchAttempt.
  const row = queue.getQueueSnapshot().find((item) => item.id === enqueued.queueItem.id)!;
  row.status = 'dispatching';
  await queue.persistQueueNow();
  runStore.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
    launchPlanId: 'lp_restart',
    launchCandidateId: 'baseline',
    launchAttempt: row.launchAttempt,
  } as never);

  await queue.loadQueue();
  // Row reconciled to its run — NOT re-queued (a re-dispatch would mint a second
  // run with the same attempt and alternate candidate ownership).
  assert.equal(
    queue.getQueueSnapshot().some((item) => item.id === enqueued.queueItem.id),
    false,
  );
});

test('restart re-queues a dispatching launch-candidate row with no durable run', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Restart requeue',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_requeue',
      version: 1,
      candidates: [
        {
          id: 'baseline',
          role: 'baseline',
          runner: 'claude',
          model: 'opus',
          slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
        },
      ],
    },
  });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  const row = queue.getQueueSnapshot().find((item) => item.id === enqueued.queueItem.id)!;
  row.status = 'dispatching';
  await queue.persistQueueNow();

  await queue.loadQueue();
  // Shutdown hit between dequeue and run creation: the attempt was never used by
  // any run, so re-queuing (attempt intact) is safe and loses no work.
  const reloaded = queue.getQueueSnapshot().find((item) => item.id === enqueued.queueItem.id);
  assert.equal(reloaded?.status, 'queued');
  assert.equal(reloaded?.launchAttempt, row.launchAttempt);
});

test('restart attempt matrix: mismatched attempts re-queue, only exact matches drop', async () => {
  const { backlog, queue, runStore } = await freshStores();
  const mkItem = async (planId: string) =>
    (
      await backlog.createBacklogItem({
        project: 'farmslot-farm',
        title: `Attempt matrix ${planId}`,
        sourceKind: 'manual',
        flowType: 'dev',
        status: 'ready',
        launchPlan: {
          id: planId,
          version: 1,
          candidates: [
            {
              id: 'baseline',
              role: 'baseline',
              runner: 'claude',
              model: 'opus',
              slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
            },
          ],
        },
      })
    ).item;
  const mkRun = (item: { id: string; sourceRef: string }, planId: string, launchAttempt?: number) =>
    runStore.createRun({
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: item.sourceRef,
      backlogItemId: item.id,
      launchPlanId: planId,
      launchCandidateId: 'baseline',
      ...(launchAttempt === undefined ? {} : { launchAttempt }),
    } as never);

  // Case 1: retry row (attempt 2) vs old TERMINAL run (attempt 1) — the retry
  // must survive restart; dropping it would strand the re-dispatch.
  const retryItem = await mkItem('lp_retry_mx');
  const retryEnqueued = await backlog.enqueueBacklogItem({ itemId: retryItem.id });
  const retryRow = queue.getQueueSnapshot().find((row) => row.id === retryEnqueued.queueItem.id)!;
  retryRow.status = 'dispatching';
  retryRow.launchAttempt = 2;
  const oldRun = mkRun(retryItem, 'lp_retry_mx', 1);
  runStore.updateRun(oldRun.id, { status: 'failed' } as never);

  // Case 2: legacy row (no attempt) vs attempt-bearing run — undefined !== 1, re-queue.
  const legacyItem = await mkItem('lp_legacy_mx');
  const legacyEnqueued = await backlog.enqueueBacklogItem({ itemId: legacyItem.id });
  const legacyRow = queue.getQueueSnapshot().find((row) => row.id === legacyEnqueued.queueItem.id)!;
  legacyRow.status = 'dispatching';
  delete legacyRow.launchAttempt;
  mkRun(legacyItem, 'lp_legacy_mx', 1);

  // Case 3: legacy row vs legacy run (both undefined) — match, drop.
  const bothLegacyItem = await mkItem('lp_bothlegacy_mx');
  const bothLegacyEnqueued = await backlog.enqueueBacklogItem({ itemId: bothLegacyItem.id });
  const bothLegacyRow = queue
    .getQueueSnapshot()
    .find((row) => row.id === bothLegacyEnqueued.queueItem.id)!;
  bothLegacyRow.status = 'dispatching';
  delete bothLegacyRow.launchAttempt;
  mkRun(bothLegacyItem, 'lp_bothlegacy_mx', undefined);

  await queue.persistQueueNow();
  await queue.loadQueue();
  const snapshot = queue.getQueueSnapshot();
  const find = (id: string) => snapshot.find((row) => row.id === id);
  assert.equal(find(retryRow.id)?.status, 'queued'); // survived, attempt intact
  assert.equal(find(retryRow.id)?.launchAttempt, 2);
  assert.equal(find(legacyRow.id)?.status, 'queued'); // undefined !== 1 -> survived
  assert.equal(find(bothLegacyRow.id), undefined); // undefined === undefined -> dropped
});

test('a comparison-candidate replay is observed while the plan is terminal', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Replay after failure',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_replay',
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
  const mkRun = (candidate: string, launchAttempt: number, status: string) => {
    const run = runStore.createRun({
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: created.item.sourceRef,
      backlogItemId: created.item.id,
      launchPlanId: 'lp_replay',
      launchCandidateId: candidate,
      launchAttempt,
    } as never);
    return runStore.updateRun(run.id, { status } as never);
  };
  await backlog.markBacklogRunObserved({ ...mkRun('baseline', 1, 'monitoring') } as never);
  const sonnetRun = mkRun('sonnet', 1, 'failed');
  await backlog.markBacklogRunObserved({ ...sonnetRun } as never);
  const item = () => backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item()?.status, 'failed'); // rollUp: any failed candidate fails the plan

  // Replay the failed comparison run (same run id re-activated). Before the
  // candidate-aware gate this observation was dropped because item.runId tracks
  // the baseline, leaving the plan terminally failed while the replay ran.
  runStore.updateRun(sonnetRun.id, { status: 'monitoring' } as never);
  await backlog.markBacklogRunObserved({ ...sonnetRun, status: 'monitoring' } as never);
  const sonnetProjection = item()?.launchPlanState?.candidates.find(
    (c) => c.candidateId === 'sonnet',
  );
  assert.equal(sonnetProjection?.status, 'running');
  assert.equal(item()?.status, 'running'); // no failed projections remain
});

test('multiPr survives persistence and reload', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Persisted multiPr',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    multiPr: true,
  });
  await backlog.flushBacklogForTests();
  await backlog.loadBacklog();
  const reloaded = backlog
    .listBacklogItems({ includeArchived: true })
    .items.find((item) => item.id === created.item.id);
  assert.equal(reloaded?.multiPr, true);
});

test('multiPr cannot be combined with launchPlan', async () => {
  const { backlog } = await freshStores();
  await assert.rejects(
    () =>
      backlog.createBacklogItem({
        project: 'farmslot-farm',
        title: 'Bad combo',
        sourceKind: 'manual',
        flowType: 'dev',
        status: 'candidate',
        multiPr: true,
        launchPlan: {
          id: 'lp_bad',
          version: 1,
          candidates: [
            {
              id: 'baseline',
              role: 'baseline',
              runner: 'claude',
              model: 'opus',
              slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
            },
          ],
        },
      }),
    /multiPr cannot be combined with launchPlan/,
  );
});

test('close-shipped finalizes a multi-PR item after its last slice', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Multi-slice closeout',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    multiPr: true,
  });
  created.item.status = 'running';
  created.item.runId = 'final-slice-run';
  await backlog.markBacklogRunObserved({
    id: 'final-slice-run',
    status: 'done',
    backlogItemId: created.item.id,
  } as never);

  const closed = await backlog.closeShippedBacklogItem({
    itemId: created.item.id,
    prRef: 'deeeed/farmslot#999',
  });
  assert.equal(closed.item.status, 'done');
  assert.equal(closed.item.shipped?.prRef, 'deeeed/farmslot#999');
});

test('backlog.update toggles the multi-PR marker', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Toggle multiPr',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'candidate',
  });
  const marked = await backlog.updateBacklogItem({ itemId: created.item.id, multiPr: true });
  assert.equal(marked.item.multiPr, true);
  const cleared = await backlog.updateBacklogItem({ itemId: created.item.id, multiPr: false });
  assert.equal(cleared.item.multiPr, undefined);
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

  await backlog.markBacklogRunObserved({
    id: 'run-terminal',
    status: 'failed',
  } as never);

  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'done');
  assert.equal(item?.lastObservedRunStatus, undefined);
});

test('run observation reactivates a failed item when its own run is replayed', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Replayed after fail',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'failed';
  created.item.runId = 'run-replayed';
  created.item.lastObservedRunStatus = 'failed';

  // Replaying the item's own run moves it back to a non-terminal status; the
  // backlog item must follow instead of staying stuck at failed.
  await backlog.markBacklogRunObserved({
    id: 'run-replayed',
    status: 'preparing',
    backlogItemId: created.item.id,
  } as never);

  const item = backlog.listBacklogItems({ includeArchived: true }).items[0];
  assert.equal(item?.status, 'running');
  assert.equal(item?.lastObservedRunStatus, 'preparing');
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

  await backlog.markBacklogRunObserved({
    id: 'parent-run',
    status: 'cancelled',
    backlogItemId: created.item.id,
  } as never);
  await backlog.markBacklogRunObserved({
    id: 'successor-run',
    status: 'done',
    backlogItemId: created.item.id,
  } as never);

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

  const graphIds = await backlog.markBacklogRunReleased('deleted-run');
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
    launchAttempt: enqueued.queueItem.launchAttempt,
    runner: enqueued.queueItem.runner,
    model: enqueued.queueItem.model,
    slotId: enqueued.queueItem.slotId,
  } as never);
  await backlog.markBacklogRunStarted(enqueued.queueItem, baselineRun);
  runStore.updateRun(baselineRun.id, { status: 'done' });
  await backlog.markBacklogRunObserved({ ...baselineRun, status: 'done' } as never);

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

test('closeShipped transitions a non-terminal item to done with provenance', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Ship something out-of-band',
    sourceKind: 'manual',
    flowType: 'dev',
  });

  const closed = await backlog.closeShippedBacklogItem({
    itemId: created.item.id,
    prRef: 'deeeed/farmslot#307',
    note: 'merged while the run sat at a gate',
  });

  assert.equal(closed.item.status, 'done');
  assert.equal(closed.item.shipped?.prRef, 'deeeed/farmslot#307');
  assert.equal(closed.item.shipped?.note, 'merged while the run sat at a gate');
  assert.ok(closed.item.shipped?.closedAt);

  // Already-terminal items refuse a second close with a teach-the-escape error.
  await assert.rejects(
    () => backlog.closeShippedBacklogItem({ itemId: created.item.id }),
    (err: unknown) => {
      const rich = err as { code?: string; userAction?: string };
      assert.equal(rich.code, 'BACKLOG_ALREADY_TERMINAL');
      assert.ok(rich.userAction && rich.userAction.length > 0);
      return true;
    },
  );
});

test('closeShipped survives run-observation reconcile (no reset to ready)', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Shipped then reconciled',
    sourceKind: 'manual',
    flowType: 'dev',
  });
  await backlog.closeShippedBacklogItem({ itemId: created.item.id, prRef: 'deeeed/farmslot#308' });

  // Reconcile passes must not resurrect the item: done is terminal. Flush the
  // debounced persist first so the reload sees the closed state.
  await backlog.flushBacklogForTests();
  await backlog.loadBacklog();
  const after = backlog.listBacklogItems({}).items.find((item) => item.id === created.item.id);
  assert.equal(after?.status, 'done');
  assert.equal(after?.shipped?.prRef, 'deeeed/farmslot#308');
});

test('closeShipped on a queued item removes the queue row and survives reconcile', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Queued then shipped out-of-band',
    sourceKind: 'manual',
    flowType: 'dev',
  });
  await backlog.markBacklogItemReady({ itemId: created.item.id });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  assert.equal(enqueued.item.status, 'queued');

  const closed = await backlog.closeShippedBacklogItem({
    itemId: created.item.id,
    prRef: 'deeeed/farmslot#309',
  });
  assert.equal(closed.item.status, 'done');
  assert.equal(closed.item.queuedQueueItemId, undefined);
  assert.equal(
    queue.getQueueSnapshot().some((row) => row.backlogItemId === created.item.id),
    false,
  );

  // Reload + reconcile must not resurrect the queue linkage.
  await backlog.flushBacklogForTests();
  await backlog.loadBacklog();
  const after = backlog.listBacklogItems({}).items.find((item) => item.id === created.item.id);
  assert.equal(after?.status, 'done');
});

test('closeShipped refuses items with an active run', async () => {
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Actively running',
    sourceKind: 'manual',
    flowType: 'dev',
  });
  created.item.status = 'running';
  created.item.runId = 'run-live-1';

  await assert.rejects(
    () => backlog.closeShippedBacklogItem({ itemId: created.item.id }),
    (err: unknown) => {
      const rich = err as { code?: string; userAction?: string };
      assert.equal(rich.code, 'BACKLOG_ITEM_ACTIVE');
      assert.match(rich.userAction ?? '', /farmslot run cancel run-live-1/u);
      return true;
    },
  );
});

test('closeShipped refuses items whose queue row is mid-dispatch', async () => {
  const { backlog, queue } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Mid-dispatch handoff',
    sourceKind: 'manual',
    flowType: 'dev',
  });
  await backlog.markBacklogItemReady({ itemId: created.item.id });
  const enqueued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
  const row = queue.getQueueSnapshot().find((candidate) => candidate.id === enqueued.queueItem.id);
  assert.ok(row);
  row.status = 'dispatching';

  await assert.rejects(
    () => backlog.closeShippedBacklogItem({ itemId: created.item.id }),
    (err: unknown) => {
      const rich = err as { code?: string; userAction?: string };
      assert.equal(rich.code, 'BACKLOG_ITEM_ACTIVE');
      assert.match(rich.userAction ?? '', /run cancel/u);
      return true;
    },
  );
});

test('a failed backlog write rejects the settle instead of reporting a settled cancel', async (t) => {
  // Codex round-8 P2: the settle resolved after merely *scheduling* the persist, and
  // `schedulePersist` drops the write's rejection. ADR-053's `backlog-settle` effect
  // would report `ok`, tick the scheduler, and skip `backlogReconcilePending` while
  // the durable file still held pre-cancel state.
  const { backlog } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Settle must fail loudly',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
  created.item.status = 'needs-attention';
  created.item.runId = 'settle-persist-failure';
  created.item.lastObservedRunStatus = 'blocked';

  // Make the backlog file undeletable/unwritable by removing write permission on its
  // directory, so `persist()` fails on the temp-file write.
  const backlogDir = path.dirname(process.env.FARMSLOT_BACKLOG_FILE!);
  await chmod(backlogDir, 0o500);
  t.after(() => chmod(backlogDir, 0o700));

  await assert.rejects(
    () =>
      backlog.markBacklogRunObserved({
        id: 'settle-persist-failure',
        status: 'done',
        backlogItemId: created.item.id,
      } as never),
    'a backlog write failure must reach the transition router',
  );
});
