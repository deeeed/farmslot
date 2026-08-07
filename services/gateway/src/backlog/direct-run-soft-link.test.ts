// Proves run.create soft-links (or warns about) backlog items with the same sourceRef.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const SOURCE_REF_AWAIT = 'TAT-69006';
const SOURCE_REF_RECONCILE = 'TAT-69007';
const SOURCE_REF_RECONCILE_MISMATCH = 'TAT-69008';
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
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Jira ticket already on the board',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_LINK,
      flowType: 'fix-bug',
      status: 'candidate',
    },
    { kind: 'system' },
  );
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
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Already linked elsewhere',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_WARN,
      flowType: 'fix-bug',
      status: 'ready',
    },
    { kind: 'system' },
  );

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
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Unrelated board item',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_NONE,
      flowType: 'fix-bug',
      status: 'candidate',
    },
    { kind: 'system' },
  );

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
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Direct dispatch should attach this item',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_RUNCREATE,
      flowType: 'fix-bug',
      status: 'ready',
    },
    { kind: 'system' },
  );

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
    assert.match(run.engineState?.interactiveDev?.initialContext ?? '', /Direct CLI run\.create/);
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

test('runCreate carries matching backlog spec context through a direct soft-link', async () => {
  const { backlog } = await freshStores();
  const { runCreate } = await import('../methods/run.js');
  const runStore = await import('../runs/store.js');
  const specPath = path.join(testDir, 'specs', 'direct-run-context.md');
  await mkdir(path.dirname(specPath), { recursive: true });
  await writeFile(
    specPath,
    '# Baseline\n\n## Acceptance Criteria\n\n- Capture production Sentry p75\n',
    'utf-8',
  );
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Direct dispatch with attached spec',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_RECONCILE,
      flowType: 'dev',
      status: 'ready',
      specPath,
      notes: 'Preserve the operator baseline context.',
    },
    { kind: 'system' },
  );

  const { run } = await runCreate(
    {
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: SOURCE_REF_RECONCILE,
      mode: 'autonomous',
    },
    () => {},
  );

  try {
    assert.equal(run.backlogItemId, created.item.id);
    assert.match(run.engineState?.interactiveDev?.initialContext ?? '', /production Sentry p75/);
    assert.match(
      run.engineState?.interactiveDev?.initialContext ?? '',
      /operator baseline context/,
    );
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
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Queue claim owns this item via markBacklogRunStarted',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_SKIP,
      flowType: 'fix-bug',
      status: 'ready',
    },
    { kind: 'system' },
  );

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

test('runCreate awaitPersist soft-links after durable stamp and persists backlogItemId', async () => {
  const { backlog } = await freshStores();
  const { runCreate } = await import('../methods/run.js');
  const runStore = await import('../runs/store.js');
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Non-backlog queue row still soft-links on awaitPersist path',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_AWAIT,
      flowType: 'fix-bug',
      status: 'ready',
    },
    { kind: 'system' },
  );

  // Production claim path for queue rows without backlogItemId (dispatch.queue.add
  // forbids backlog metadata): awaitPersist + durableStamp, then soft-link +
  // second persistRunNow('create-soft-link').
  let afterCreateSyncSeen = false;
  let durableStampSeen = false;
  const { run } = await runCreate(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: SOURCE_REF_AWAIT,
      mode: 'autonomous',
      initialContext: 'Queue claim without backlogItemId uses awaitPersist soft-link branch',
    },
    () => {},
    {
      awaitPersist: true,
      afterCreateSync: () => {
        afterCreateSyncSeen = true;
      },
      durableStamp: async () => {
        durableStampSeen = true;
      },
    },
  );

  try {
    assert.equal(afterCreateSyncSeen, true);
    assert.equal(durableStampSeen, true);
    assert.equal(run.backlogItemId, created.item.id);

    const linked = backlog.getBacklogItemSnapshot(created.item.id);
    assert.equal(linked?.status, 'running');
    assert.equal(linked?.runId, run.id);

    const onDisk = JSON.parse(await readFile(runStore.runRecordPath(run.id), 'utf8')) as {
      backlogItemId?: string;
    };
    assert.equal(onDisk.backlogItemId, created.item.id);
  } finally {
    if (runStore.getRun(run.id)) {
      runStore.updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await runStore.deleteRun(run.id);
    }
  }
});

test('reconcileBacklogRun durably links a historical graph run and applies terminal status', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Historical direct run missed its backlog handoff',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_RECONCILE,
      flowType: 'fix-bug',
      status: 'candidate',
    },
    { kind: 'system' },
  );
  backlog.mutateBacklogItemForTests(created.item.id, (item) => {
    item.workGraphId = 'graph-1';
    item.workNodeId = 'node-1';
  });

  const run = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_RECONCILE,
    mode: 'autonomous',
    initialContext: 'Historical direct run',
  });
  runStore.updateRun(run.id, {
    status: 'done',
    completedAt: '2026-07-31T00:00:00.000Z',
  });

  try {
    const result = await backlog.reconcileBacklogRun({
      itemId: created.item.id,
      runId: run.id,
    });
    assert.equal(result.item.status, 'done');
    assert.equal(result.item.runId, run.id);
    assert.equal(result.item.lastObservedRunStatus, 'done');
    assert.equal(result.run.backlogItemId, created.item.id);
    assert.equal(result.run.workGraphId, 'graph-1');
    assert.equal(result.run.workNodeId, 'node-1');

    const onDisk = JSON.parse(await readFile(runStore.runRecordPath(run.id), 'utf8')) as {
      backlogItemId?: string;
      workGraphId?: string;
      workNodeId?: string;
    };
    assert.equal(onDisk.backlogItemId, created.item.id);
    assert.equal(onDisk.workGraphId, 'graph-1');
    assert.equal(onDisk.workNodeId, 'node-1');
  } finally {
    await runStore.deleteRun(run.id);
  }
});

test('reconcileBacklogRun rejects source mismatches without linking either side', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Canonical board identity',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_RECONCILE_MISMATCH,
      flowType: 'fix-bug',
      status: 'candidate',
    },
    { kind: 'system' },
  );
  const run = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_ORPHAN,
    mode: 'autonomous',
    initialContext: 'Wrong ticket identity',
  });

  try {
    await assert.rejects(
      backlog.reconcileBacklogRun({ itemId: created.item.id, runId: run.id }),
      (err: unknown) => {
        const rich = err as { code?: string; message?: string };
        assert.equal(rich.code, 'BACKLOG_RECONCILE_REJECTED');
        assert.match(rich.message ?? '', /sourceRef.*does not match run ticketOrPr/);
        return true;
      },
    );
    assert.equal(runStore.getRun(run.id)?.backlogItemId, undefined);
    assert.equal(backlog.getBacklogItemSnapshot(created.item.id)?.runId, undefined);
    assert.equal(backlog.getBacklogItemSnapshot(created.item.id)?.status, 'candidate');
  } finally {
    runStore.updateRun(run.id, {
      status: 'failed',
      completedAt: '2026-07-31T00:00:00.000Z',
    });
    await runStore.deleteRun(run.id);
  }
});

test('loadBacklog recovers a terminal item projection from an explicit pending repair', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Backlog projection was interrupted after run persistence',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_RECONCILE,
      flowType: 'fix-bug',
      status: 'candidate',
    },
    { kind: 'system' },
  );
  await backlog.closeShippedBacklogItem({ itemId: created.item.id });
  const run = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_RECONCILE,
    mode: 'autonomous',
    initialContext: 'Durable backlink only',
  });
  const linked = runStore.updateRun(run.id, {
    status: 'done',
    completedAt: '2026-07-31T00:00:00.000Z',
    backlogItemId: created.item.id,
    backlogReconcilePending: true,
  });
  await runStore.persistRunNow(linked, 'test-reverse-backlink');
  await backlog.flushBacklogForTests();

  try {
    await backlog.loadBacklog();
    const recovered = backlog.getBacklogItemSnapshot(created.item.id);
    assert.equal(recovered?.status, 'done');
    assert.equal(recovered?.runId, run.id);
    assert.equal(recovered?.lastObservedRunStatus, 'done');
    assert.equal(runStore.getRun(run.id)?.backlogReconcilePending, undefined);
    const onDisk = JSON.parse(await readFile(runStore.runRecordPath(run.id), 'utf8')) as {
      backlogReconcilePending?: boolean;
    };
    assert.equal(onDisk.backlogReconcilePending, undefined);
  } finally {
    await runStore.deleteRun(run.id);
  }
});

test('loadBacklog keeps a queued retry authoritative over a historical run backlink', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Completed work was explicitly queued for another pass',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_RECONCILE,
      flowType: 'fix-bug',
      status: 'candidate',
    },
    { kind: 'system' },
  );
  const run = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_RECONCILE,
    mode: 'autonomous',
    initialContext: 'Historical completed run',
  });
  runStore.updateRun(run.id, {
    status: 'done',
    completedAt: '2026-07-31T00:00:00.000Z',
  });

  try {
    await backlog.reconcileBacklogRun({ itemId: created.item.id, runId: run.id });
    await backlog.markBacklogItemReady({ itemId: created.item.id });
    const queued = await backlog.enqueueBacklogItem({ itemId: created.item.id });
    const pending = runStore.updateRun(run.id, { backlogReconcilePending: true });
    await runStore.persistRunNow(pending, 'test-queue-supersedes-pending-repair');
    await backlog.flushBacklogForTests();

    await backlog.loadBacklog();
    const recovered = backlog.getBacklogItemSnapshot(created.item.id);
    assert.equal(recovered?.status, 'queued');
    assert.equal(recovered?.queuedQueueItemId, queued.queueItem.id);
    assert.equal(recovered?.runId, undefined);
    assert.equal(runStore.getRun(run.id)?.backlogItemId, undefined);
    assert.equal(runStore.getRun(run.id)?.backlogReconcilePending, undefined);
  } finally {
    await runStore.deleteRun(run.id);
  }
});

test('reconcileBacklogRun rejects a second run backlink for the same item', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Only one historical run may own the item',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_RECONCILE,
      flowType: 'fix-bug',
      status: 'candidate',
    },
    { kind: 'system' },
  );
  const first = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_RECONCILE,
    mode: 'autonomous',
    initialContext: 'Existing owner',
  });
  runStore.updateRun(first.id, { backlogItemId: created.item.id });
  const second = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_RECONCILE,
    mode: 'autonomous',
    initialContext: 'Conflicting owner',
  });

  try {
    await assert.rejects(
      backlog.reconcileBacklogRun({ itemId: created.item.id, runId: second.id }),
      /already linked from run/,
    );
    assert.equal(runStore.getRun(second.id)?.backlogItemId, undefined);
  } finally {
    runStore.updateRun(first.id, {
      status: 'failed',
      completedAt: '2026-07-31T00:00:00.000Z',
    });
    runStore.updateRun(second.id, {
      status: 'failed',
      completedAt: '2026-07-31T00:00:00.000Z',
    });
    await runStore.deleteRun(first.id);
    await runStore.deleteRun(second.id);
  }
});

test('reconcileBacklogRun makes the selected run authoritative over a stale terminal item', async () => {
  const { backlog, runStore } = await freshStores();
  const created = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Terminal projection lost its run identity',
      sourceKind: 'jira',
      sourceRef: SOURCE_REF_RECONCILE,
      flowType: 'fix-bug',
      status: 'candidate',
    },
    { kind: 'system' },
  );
  await backlog.closeShippedBacklogItem({ itemId: created.item.id });
  const run = runStore.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: SOURCE_REF_RECONCILE,
    mode: 'autonomous',
    initialContext: 'Authoritative historical run',
  });
  runStore.updateRun(run.id, {
    status: 'done',
    completedAt: '2026-07-31T00:00:00.000Z',
  });

  try {
    const result = await backlog.reconcileBacklogRun({
      itemId: created.item.id,
      runId: run.id,
    });
    assert.equal(result.item.status, 'done');
    assert.equal(result.item.runId, run.id);
    assert.equal(result.item.lastObservedRunStatus, 'done');
  } finally {
    await runStore.deleteRun(run.id);
  }
});
