// Proves run.create soft-links (or warns about) backlog items with the same sourceRef.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';

const testDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-soft-link-test-'));
process.env.FARMSLOT_BACKLOG_FILE = path.join(testDir, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(testDir, 'queue.json');
process.env.FARMSLOT_BACKLOG_SPEC_DIR = path.join(testDir, 'specs');
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';

// Fixed refs — each test calls freshStores() so backlog is empty; no Date.now().
const SOURCE_REF_LINK = 'TAT-69001';
const SOURCE_REF_WARN = 'TAT-69002';
const SOURCE_REF_RUNCREATE = 'TAT-69003';
const SOURCE_REF_NONE = 'TAT-69004';
const SOURCE_REF_SKIP = 'TAT-69005';
const SOURCE_REF_ORPHAN = 'TAT-69999';

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
  const slots = [testSlot('macwork-ff-1')];
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
  await rm(testDir, { recursive: true, force: true });
});

async function freshStores() {
  const backlog = await import('./store.js');
  const queue = await import('./dispatch-queue.js');
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
  return { backlog, queue, runStore };
}

test('linkDirectRunToMatchingBacklog soft-links candidate item matching sourceRef', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Jira ticket already on the board',
    sourceKind: 'jira',
    sourceRef: SOURCE_REF_LINK,
    flowType: 'fix-bug',
    status: 'candidate',
  });
  assert.equal(created.item.status, 'candidate');
  assert.equal(created.item.runId, undefined);

  const run = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_LINK,
    mode: 'autonomous',
    initialContext: 'Direct run.create bypassing backlog.enqueue',
  });
  assert.equal(run.backlogItemId, undefined);

  const result = await backlog.linkDirectRunToMatchingBacklog(run);
  assert.equal(result.action, 'linked');
  if (result.action !== 'linked') return;
  assert.equal(result.itemId, created.item.id);

  const linked = backlog.getBacklogItemSnapshot(created.item.id);
  assert.equal(linked?.status, 'running');
  assert.equal(linked?.runId, run.id);
});

test('linkDirectRunToMatchingBacklog warns when matching item is already run-linked', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Already linked elsewhere',
    sourceKind: 'jira',
    sourceRef: SOURCE_REF_WARN,
    flowType: 'fix-bug',
    status: 'ready',
  });

  // Establish the existing link through the soft-link path (no live-object mutate).
  const firstRun = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_WARN,
    mode: 'autonomous',
    initialContext: 'First direct create links the item',
  });
  const first = await backlog.linkDirectRunToMatchingBacklog(firstRun);
  assert.equal(first.action, 'linked');

  const secondRun = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_WARN,
    mode: 'autonomous',
    initialContext: 'Second direct create for same sourceRef',
  });

  const result = await backlog.linkDirectRunToMatchingBacklog(secondRun);
  assert.equal(result.action, 'warned');
  if (result.action !== 'warned') return;
  assert.equal(result.itemId, created.item.id);
  assert.match(result.reason, /already linked/i);

  const after = backlog.getBacklogItemSnapshot(created.item.id);
  assert.equal(after?.runId, firstRun.id);
});

test('linkDirectRunToMatchingBacklog returns none when no sourceRef matches', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Unrelated board item',
    sourceKind: 'jira',
    sourceRef: SOURCE_REF_NONE,
    flowType: 'fix-bug',
    status: 'candidate',
  });

  const run = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_ORPHAN,
    mode: 'autonomous',
    initialContext: 'No matching backlog sourceRef',
  });

  const result = await backlog.linkDirectRunToMatchingBacklog(run);
  assert.equal(result.action, 'none');

  const after = backlog.getBacklogItemSnapshot(created.item.id);
  assert.equal(after?.status, 'candidate');
  assert.equal(after?.runId, undefined);
});

test('runCreate soft-links jira backlog item by sourceRef and stamps run.backlogItemId', async () => {
  const { backlog } = await freshStores();
  const { runCreate } = await import('../methods/run.js');
  const runStore = await import('../runs/store.js');
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Direct dispatch should attach this item',
    sourceKind: 'jira',
    sourceRef: SOURCE_REF_RUNCREATE,
    flowType: 'fix-bug',
    status: 'ready',
  });

  const { run } = await runCreate(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: SOURCE_REF_RUNCREATE,
      mode: 'autonomous',
      initialContext: 'Direct CLI run.create for existing backlog sourceRef',
    },
    () => {},
  );

  try {
    assert.equal(run.backlogItemId, created.item.id);
    const linked = backlog.getBacklogItemSnapshot(created.item.id);
    assert.equal(linked?.status, 'running');
    assert.equal(linked?.runId, run.id);
  } finally {
    if (runStore.getRun(run.id)) {
      runStore.updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await runStore.deleteRun(run.id);
    }
  }
});

test('runCreate skips soft-link when params.backlogItemId is set (queue handoff path)', async () => {
  const { backlog } = await freshStores();
  const { runCreate } = await import('../methods/run.js');
  const runStore = await import('../runs/store.js');
  const created = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Queue claim owns this item via markBacklogRunStarted',
    sourceKind: 'jira',
    sourceRef: SOURCE_REF_SKIP,
    flowType: 'fix-bug',
    status: 'ready',
  });

  // Passing backlogItemId is the queue-claim path: soft-link must not run
  // (markBacklogRunStarted owns the status/runId transition after create).
  const { run } = await runCreate(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: SOURCE_REF_SKIP,
      mode: 'autonomous',
      initialContext: 'Queue-claimed create with backlogItemId already set',
      backlogItemId: created.item.id,
    },
    () => {},
  );

  try {
    assert.equal(run.backlogItemId, created.item.id);
    // Soft-link skipped → item stays ready with no runId until markBacklogRunStarted.
    const after = backlog.getBacklogItemSnapshot(created.item.id);
    assert.equal(after?.status, 'ready');
    assert.equal(after?.runId, undefined);
  } finally {
    if (runStore.getRun(run.id)) {
      runStore.updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await runStore.deleteRun(run.id);
    }
  }
});
