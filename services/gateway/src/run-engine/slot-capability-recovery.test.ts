import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import type { Run, RuntimeCapabilityCatalogEntry } from '@farmslot/protocol';
import {
  currentProjectSources,
  type ProjectSourceContext,
  SlotConfigError,
  withProjectSources,
} from '@farmslot/slot-config';

import { sourceTestLock, sourceTestMaterialization } from '../sources/source.test-support.js';

process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
await import('../runtime/mock-pty.test-support.js');
const context = (nodeId: string): ProjectSourceContext => {
  const lock = sourceTestLock(nodeId);
  return {
    project: 'demo',
    pack: lock.packBindings.demo,
    packs: lock.packBindings,
    materialization: sourceTestMaterialization(lock, 'gateway'),
  };
};
const android = {
  id: 'android-device',
  project: 'demo',
  label: 'Android',
  version: '1',
  sharePolicy: 'exclusive',
  cost: { class: 'low', resources: [{ id: 'device', kind: 'device', access: 'exclusive' }] },
  actions: {
    acquire: { kind: 'slot-action', actionId: 'boot' },
    health: { kind: 'slot-action', actionId: 'health' },
    release: { kind: 'slot-action', actionId: 'stop' },
  },
  releaseEffects: [],
  provenance: { project: 'demo', providerId: 'android-device', version: '1', digest: 'android' },
  availability: { state: 'available' },
} satisfies RuntimeCapabilityCatalogEntry;
const sourceRuntime = await import('../sources/runtime.js');
let sourceReads = 0;
mock.module('../sources/runtime.js', {
  namedExports: {
    ...sourceRuntime,
    withRunSources: async (
      _run: Run,
      operation: () => Promise<unknown>,
      options?: { planning?: boolean },
    ) => {
      assert.equal(options?.planning, true);
      sourceReads++;
      return withProjectSources(context('pinned-android'), operation);
    },
  },
});
const capabilities = await import('../methods/runtime-capabilities.js');
let readError: Error | undefined;
mock.module('../methods/runtime-capabilities.js', {
  namedExports: {
    ...capabilities,
    runtimeCapabilityList: async ({ slotId }: { slotId: string }) => {
      if (readError) throw readError;
      assert.equal(currentProjectSources()?.materialization.lock.context.nodeId, 'pinned-android');
      return { slotId, project: 'demo', capabilities: [android] };
    },
  },
});
const store = await import('../runs/store.js');
const queue = await import('../backlog/dispatch-queue.js');
const { runReplayStep } = await import('../methods/run/replay-step.js');
const { replaySlotCapabilityRequirements, slotCapabilityBlocker, slotCapabilityCatalogs } =
  await import('./slot-capability-requirements.js');

function runFixture(t: TestContext, cancelled = false) {
  const run = store.createRun({
    flowType: 'dev',
    project: 'demo',
    ticketOrPr: 'PROJ-123',
    ...(cancelled
      ? { workGraphId: 'capability-replay-graph', workNodeId: 'capability-replay-node' }
      : {}),
  });
  store.updateRun(run.id, {
    status: cancelled ? 'cancelled' : 'failed',
    slotId: 'old-device-slot',
    ...(cancelled ? { completedAt: new Date().toISOString() } : {}),
  });
  t.after(async () => {
    readError = undefined;
    store.updateRun(run.id, { status: 'failed' });
    await store.deleteRun(run.id);
  });
  return run;
}

test('replay captures providers under the retained source configuration', async (t) => {
  const run = runFixture(t);
  const before = sourceReads;
  const result = await runReplayStep({ runId: run.id, stepName: 'find-slot' }, () => {});
  assert.ok(sourceReads > before);
  assert.deepEqual(result.run.engineState?.slotCapabilityRequirements?.capabilityIds, [
    'android-device',
  ]);
});

test('candidate catalogs stay isolated under each planned node configuration', async () => {
  const plans = new Map(
    ['android', 'ios'].map((nodeId) => [
      nodeId,
      {
        params: { project: 'demo', flowType: 'dev' as const, ticketOrPr: 'PROJ-123' },
        sources: context(nodeId),
      },
    ]),
  );
  const seen: string[] = [];
  const catalogs = await slotCapabilityCatalogs(
    ['android', 'ios'],
    ['android-device'],
    plans,
    async (slotId) => {
      await Promise.resolve();
      const node = currentProjectSources()!.materialization.lock.context.nodeId!;
      seen.push(node);
      return { slotId, project: 'demo', capabilities: node === 'android' ? [android] : [] };
    },
  );
  assert.deepEqual(seen.sort(), ['android', 'ios']);
  assert.equal(slotCapabilityBlocker('android', ['android-device'], catalogs), null);
  assert.match(slotCapabilityBlocker('ios', ['android-device'], catalogs)!, /unavailable/);
  assert.equal(currentProjectSources(), undefined);
});

test('removed source slots do not strand replay and retained requirements are never dropped', async (t) => {
  readError = new SlotConfigError('SLOT_NOT_FOUND', 'source slot was removed');
  const run = runFixture(t);
  const result = await runReplayStep({ runId: run.id, stepName: 'find-slot' }, () => {});
  assert.equal(result.run.slotId, null);
  assert.equal(result.run.engineState?.slotCapabilityRequirements, undefined);
  const retained = { sourceSlotId: 'removed', capabilityIds: ['android-device'] };
  assert.deepEqual(
    await replaySlotCapabilityRequirements({
      slotId: 'removed',
      engineState: { slotCapabilityRequirements: retained },
    }),
    retained,
  );
});

test('catalog-read refusal immediately releases a cancelled run replacement queue claim', async (t) => {
  const run = runFixture(t, true);
  const item = queue.addItem(
    {
      project: 'demo',
      flowType: 'dev',
      ticketOrPr: 'PROJ-123',
      workGraphId: run.workGraphId,
      workNodeId: run.workNodeId,
    },
    { kind: 'system' },
  );
  t.after(() => queue.removeQueueItemInternal(item.id, 'fixture teardown'));
  readError = new SyntaxError('unreadable project configuration');
  await assert.rejects(
    runReplayStep({ runId: run.id, stepName: 'find-slot' }, () => {}),
    /unreadable project configuration/,
  );
  const replacement = queue.getQueueSnapshot().find((candidate) => candidate.id === item.id)!;
  assert.equal(replacement.status, 'queued');
  assert.equal(replacement.claimHolder, undefined);
  assert.equal(replacement.claimExpiresAt, undefined);
  assert.equal(store.getRun(run.id)?.status, 'cancelled');
});
