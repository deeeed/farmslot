process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'farmslot-provenance-'));
const queueFile = join(root, 'dispatch-queue.json');
const backlogFile = join(root, 'backlog.json');
const graphDir = join(root, 'work-graphs');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = queueFile;
process.env.FARMSLOT_BACKLOG_FILE = backlogFile;
process.env.FARMSLOT_WORK_GRAPH_DIR = graphDir;
process.env.FARMSLOT_HOME = join(root, 'home');

const now = new Date().toISOString();
writeFileSync(
  queueFile,
  JSON.stringify([
    {
      id: 'legacy-queue',
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: 'legacy queue',
      allowedSlots: ['provenance-slot'],
      priority: 10,
      createdAt: now,
      status: 'queued',
    },
  ]),
);
writeFileSync(
  backlogFile,
  JSON.stringify([
    {
      id: 'legacy-backlog',
      project: 'farmslot-farm',
      title: 'Legacy backlog',
      sourceKind: 'manual',
      sourceRef: 'MANUAL-000001',
      flowType: 'dev',
      status: 'candidate',
      priority: 10,
      createdAt: now,
      updatedAt: now,
    },
  ]),
);

mkdirSync(graphDir, { recursive: true });
writeFileSync(
  join(graphDir, 'wg_legacy.json'),
  JSON.stringify({
    graph: {
      id: 'wg_legacy',
      version: 1,
      project: 'farmslot-farm',
      title: 'Legacy graph',
      source: { kind: 'manual' },
      status: 'planning',
      defaultFailurePolicy: 'halt',
      scheduler: {},
      createdAt: now,
      updatedAt: now,
    },
    nodes: [],
    edges: [],
    gates: [],
    ledger: [],
  }),
);

const queue = await import('./dispatch-queue.js');
const backlog = await import('./store.js');
const workGraph = await import('../work-graph/store.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import('../security/auth.js');
const { authorizeStoredRunEffect } = await import('../security/authorization.js');
const { setCachedFleetForTests } = await import('../fleet/state.js');
const { resolveWorkOriginator, runWithSessionOriginator } =
  await import('../security/work-originator.js');
const { dispatchQueueUpdate } = await import('../methods/dispatch/queue.js');

test('legacy migration is per-store, observable, one-time, and public projections stay clean', async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    const legacyOriginator = { kind: 'principal' as const, principalId: 'local-admin' };
    await queue.loadQueue(legacyOriginator);
    await backlog.loadBacklog(legacyOriginator);
    await workGraph.loadWorkGraphs(legacyOriginator);

    assert.deepEqual(queue.queueRecordOriginator('legacy-queue'), legacyOriginator);
    assert.deepEqual(backlog.backlogRecordOriginator('legacy-backlog'), legacyOriginator);
    assert.deepEqual(workGraph.workGraphRecordOriginator('wg_legacy'), legacyOriginator);
    assert.ok(logs.some((line) => line.includes('dispatch queue migrated 1 item(s)')));
    assert.ok(logs.some((line) => line.includes('backlog migrated 1 item(s)')));
    assert.ok(logs.some((line) => line.includes('work graph migrated 1 item(s)')));

    const runtime = createGatewayAuthRuntime({
      FARMSLOT_HOME: join(root, 'authorization-home'),
      GATEWAY_HOST: '127.0.0.1',
    });
    initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
    let legacyDispatches = 0;
    queue.initDispatchQueue(
      () => undefined,
      async (record) => {
        authorizeStoredRunEffect(
          resolveWorkOriginator(runtime, record.originator),
          record.label || record.id,
          undefined,
        );
        legacyDispatches += 1;
      },
    );
    setCachedFleetForTests(readyFleet('provenance-slot'));
    await queue.tryDispatchNext();
    assert.equal(legacyDispatches, 1, 'a migrated pre-provenance queue row must still dispatch');

    const events: unknown[] = [];
    queue.initDispatchQueue(
      (_event, payload) => events.push(payload),
      async () => undefined,
    );
    const added = queue.addItem(
      {
        flowType: 'dev',
        project: 'farmslot-farm',
        ticketOrPr: 'new queue',
        priority: 20,
        autoDispatch: false,
      },
      { kind: 'principal', principalId: 'owner' },
    );
    assert.equal(Object.keys(added).includes('originator'), false);
    const updated = queue.updateItem(
      { itemId: added.id, label: 'edited' },
      { kind: 'principal', principalId: 'sam' },
    );
    assert.equal(Object.keys(updated).includes('originator'), false);
    assert.deepEqual(queue.queueRecordOriginator(added.id), {
      kind: 'principal',
      principalId: 'sam',
    });
    assert.equal(JSON.stringify(queue.listItems()).includes('principalId'), false);
    assert.equal(JSON.stringify(events).includes('principalId'), false);
    const reauthored = runWithSessionOriginator(
      {
        id: 'editor',
        subject: { type: 'person', displayName: 'editor' },
        roles: [{ role: 'admin', scope: { kind: 'global' } }],
      },
      () => dispatchQueueUpdate({ itemId: added.id, label: 'edited again' }),
    );
    assert.match(reauthored.authorshipNotice ?? '', /re-authored[\s\S]*current authority/u);
    assert.deepEqual(queue.queueRecordOriginator(added.id), {
      kind: 'principal',
      principalId: 'editor',
    });
    await queue.persistQueueNow();

    const createdBacklog = await backlog.createBacklogItem(
      {
        project: 'farmslot-farm',
        title: 'New backlog',
        sourceKind: 'manual',
        flowType: 'dev',
      },
      { kind: 'principal', principalId: 'owner' },
    );
    assert.equal(Object.keys(createdBacklog.item).includes('originator'), false);
    await backlog.markBacklogItemNeedsAttention({
      itemId: createdBacklog.item.id,
      reason: 'internal lifecycle transition',
    });
    assert.deepEqual(backlog.backlogRecordOriginator(createdBacklog.item.id), {
      kind: 'principal',
      principalId: 'owner',
    });
    await backlog.flushBacklogForTests();

    const createdGraph = await workGraph.createWorkGraph(
      { id: 'wg_new', project: 'farmslot-farm', title: 'New graph' },
      { kind: 'principal', principalId: 'owner' },
    );
    assert.equal(JSON.stringify(createdGraph).includes('principalId'), false);
    assert.deepEqual(workGraph.workGraphRecordOriginator('wg_new'), {
      kind: 'principal',
      principalId: 'owner',
    });

    stripOriginatorFromArray(queueFile, added.id);
    stripOriginatorFromArray(backlogFile, createdBacklog.item.id);
    const graphPath = join(graphDir, 'wg_new.json');
    const graphJson = JSON.parse(readFileSync(graphPath, 'utf8')) as Record<string, unknown>;
    delete graphJson.originator;
    writeFileSync(graphPath, JSON.stringify(graphJson));

    logs.length = 0;
    await queue.loadQueue(legacyOriginator);
    await backlog.loadBacklog(legacyOriginator);
    await workGraph.loadWorkGraphs(legacyOriginator);
    assert.equal(queue.queueRecordOriginator(added.id), undefined);
    assert.equal(backlog.backlogRecordOriginator(createdBacklog.item.id), undefined);
    assert.equal(workGraph.workGraphRecordOriginator('wg_new'), undefined);
    assert.equal(
      logs.some((line) => line.includes('migrated 1 item(s)')),
      false,
    );

    let corruptEffects = 0;
    let corruptDenial = '';
    queue.initDispatchQueue(
      () => undefined,
      async (record) => {
        try {
          authorizeStoredRunEffect(
            resolveWorkOriginator(runtime, record.originator),
            `new queue (${record.id})`,
            undefined,
          );
          corruptEffects += 1;
        } catch (error) {
          corruptDenial = (error as Error).message;
          throw error;
        }
      },
    );
    setCachedFleetForTests(readyFleet('provenance-slot'));
    await queue.tryDispatchNext();
    assert.equal(corruptEffects, 0);
    assert.match(corruptDenial, new RegExp(`${added.id}[\\s\\S]*cannot be resolved`, 'u'));
    assert.ok(queue.getQueueSnapshot().some((record) => record.id === added.id));

    const legacyPrincipal = resolveWorkOriginator(runtime, legacyOriginator);
    assert.equal(
      authorizeStoredRunEffect(legacyPrincipal, 'legacy-queue', undefined).id,
      'local-admin',
    );
    assert.throws(
      () =>
        authorizeStoredRunEffect(
          resolveWorkOriginator(runtime, queue.queueRecordOriginator(added.id)),
          `new queue (${added.id})`,
          undefined,
        ),
      new RegExp(`${added.id}[\\s\\S]*cannot be resolved`, 'u'),
    );
  } finally {
    console.log = originalLog;
  }
});

function readyFleet(slot: string) {
  return {
    checkedAt: '2026-08-06T00:00:00.000Z',
    slots: [
      {
        slot,
        machine: 'local',
        platform: 'cli' as const,
        project: 'farmslot-farm',
        health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
        branch: 'main',
        agent: 'idle' as const,
        enabled: true,
        dispatchable: true,
        lifecycle: 'ready' as const,
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
      },
    ],
    summary: {
      total: 1,
      ready: 1,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  };
}

function stripOriginatorFromArray(path: string, id: string): void {
  const records = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
  const target = records.find((record) => record.id === id);
  assert.ok(target);
  delete target.originator;
  writeFileSync(path, JSON.stringify(records));
}
