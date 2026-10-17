import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import type { RunSourceProvenance, SourceLock } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'source-planning-recovery-'));
await mkdir(path.join(root, 'pool'));
await mkdir(path.join(root, 'home'));
Object.assign(process.env, {
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_SOURCES_CONFIG: path.join(root, 'sources.json'),
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
});
await writeFile(
  path.join(root, 'sources.json'),
  JSON.stringify({ packs: { demo: { sourceId: 'pack', entry: '.' } } }),
);
await import('../runtime/mock-pty.test-support.js');
const { SourceMaterializer } = await import('@farmslot/slot-config/sources');
const { currentProjectSources } = await import('@farmslot/slot-config');
const { SourceAuthority } = await import('./authority.js');
const { initializeSources, stopSourceReconciliation, withRunSources } =
  await import('./runtime.js');
const { sourceTestLock, sourceTestMaterialization } = await import('./source.test-support.js');
const { currentSourceResourceChanges } = await import('./change-signal.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');
const store = await import('../runs/store.js');
const { runReplayStep } = await import('../methods/run/replay-step.js');

function provenance(lock = sourceTestLock()): RunSourceProvenance {
  return {
    state: 'locked',
    attemptId: 'original',
    lock,
    workerLock: lock,
    receiptIds: ['original-receipt'],
    bindings: [lock.packBindings.demo],
    attempts: [{ id: 'original', receiptIds: ['original-receipt'] }],
  };
}

async function initialize(t: TestContext) {
  const materialized: SourceLock[] = [];
  // Only backing IO is replaced. The source context wrapper and replay are real.
  t.mock.method(SourceAuthority, 'open', async () => ({
    recoverRunCreations: async () => {},
    startReconciliation: () => () => {},
    observe: () => () => {},
    activatedAt: () => '2020-01-01T00:00:00Z',
  }));
  t.mock.method(SourceMaterializer.prototype, 'materialize', async (lock: SourceLock) => {
    materialized.push(lock);
    return sourceTestMaterialization(lock, 'gateway');
  });
  await initializeSources();
  t.after(() => stopSourceReconciliation());
  return materialized;
}

test('admitted planning uses the retained gateway lock without a removed slot or offline node', async (t) => {
  const materialized = await initialize(t);
  const run = makeRun({ project: 'demo', slotId: 'removed-old-slot' });
  run.sourceProvenance = provenance();
  const before = structuredClone(run.sourceProvenance);
  const revision = () => currentSourceResourceChanges()!.changes[0].revision;
  const revisionBefore = revision();
  const result = await withRunSources(
    run,
    async () => {
      assert.equal(currentProjectSources()!.materialization.lock.digest, before.lock.digest);
      assert.equal(currentProjectSources()!.execution, undefined);
      return 'read pinned catalog';
    },
    { planning: true, nodeId: 'offline-original-node' },
  );
  assert.equal(result, 'read pinned catalog');
  assert.equal(materialized.length, 1);
  assert.equal(revision(), revisionBefore + 1, 'the gateway receipt is announced');
  assert.deepEqual(run.sourceProvenance, before);
});

test('real find-slot replay of an admitted run succeeds after its old pool slot is removed', async (t) => {
  await initialize(t);
  const run = store.createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'PROJ-123' });
  const retained = provenance(sourceTestLock(undefined, run.id));
  store.updateRun(run.id, {
    status: 'failed',
    slotId: 'removed-old-slot',
    sourceProvenance: retained,
  });
  t.after(async () => {
    store.updateRun(run.id, { status: 'failed' });
    await store.deleteRun(run.id);
  });
  const result = await runReplayStep({ runId: run.id, stepName: 'find-slot' }, () => {});
  assert.equal(result.run.slotId, null);
  assert.equal(result.run.engineState?.slotCapabilityRequirements, undefined);
  assert.deepEqual(result.run.sourceProvenance, retained);
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});
