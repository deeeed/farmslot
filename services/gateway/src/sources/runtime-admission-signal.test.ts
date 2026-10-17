import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run, SourceLock, SourceMaterialization } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'source-admission-signal-'));
await mkdir(path.join(root, 'pool'));
await mkdir(path.join(root, 'home'));
Object.assign(process.env, {
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_SOURCES_CONFIG: path.join(root, 'sources.json'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
});
await writeFile(
  path.join(root, 'sources.json'),
  JSON.stringify({ packs: { demo: { sourceId: 'pack', entry: '.' } } }),
);
const { sourceTestLock, sourceTestMaterialization, sourceTestPlan } =
  await import('./source.test-support.js');
const provenanceFor = (run: Run, receiptIds: string[]) => {
  const lock = sourceTestLock(undefined, run.id);
  return {
    state: 'locked' as const,
    attemptId: `${run.id}:1`,
    lock,
    workerLock: lock,
    receiptIds,
    bindings: [lock.packBindings.demo],
    attempts: [],
  };
};
// Admission itself is covered by run-admission tests; this checks what the runtime's save announces.
mock.module('./run-admission.js', {
  namedExports: {
    SourcePlanRestart: class SourcePlanRestart extends Error {},
    refreshPlannedRunSources: async () => {},
    admitPlannedRunSources: async (
      runId: string,
      _target: unknown,
      deps: { getRun(id: string): Run | undefined; save(run: Run): Promise<void> },
    ) => {
      const run = deps.getRun(runId)!;
      await deps.save({ ...run, sourceProvenance: provenanceFor(run, ['gateway-receipt']) });
    },
  },
});
await import('../runtime/mock-pty.test-support.js');
const { SourceMaterializer } = await import('@farmslot/slot-config/sources');
const { SourceAuthority } = await import('./authority.js');
const { admitRunSources, initializeSources, stopSourceReconciliation, withRunSources } =
  await import('./runtime.js');
const { currentSourceResourceChanges, noteRunSourceFacts } = await import('./change-signal.js');
const store = await import('../runs/store.js');

const revision = () => currentSourceResourceChanges()!.changes[0].revision;
const runs: string[] = [];
const sourcedRun = () => {
  const run = store.createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'PROJ-1' });
  runs.push(run.id);
  return store.updateRun(run.id, { sourcePlan: sourceTestPlan(sourceTestLock(undefined, run.id)) });
};

// A run that accepts pins exists before the gateway starts, as after a restart.
const restored = sourcedRun();
mock.method(SourceAuthority, 'open', async () => ({
  recoverRunCreations: async () => {},
  startReconciliation: () => () => {},
  observe: () => () => {},
  activatedAt: () => '2020-01-01T00:00:00Z',
}));
mock.method(
  SourceMaterializer.prototype,
  'materialize',
  async (lock: SourceLock): Promise<SourceMaterialization> =>
    sourceTestMaterialization(lock, 'gateway'),
);
await initializeSources();

test('a restored run that stops accepting pins advances on its first update after a restart', () => {
  const before = revision();
  noteRunSourceFacts(store.updateRun(restored.id, { status: 'cancelled' }));
  assert.equal(revision(), before + 1);
});

test('a run admission is announced once its provenance is saved, before the next run.updated', async () => {
  const run = sourcedRun();
  const before = revision();
  await admitRunSources(run.id, { nodeId: 'node-1' });
  assert.ok(store.getRun(run.id)!.sourceProvenance);
  assert.equal(revision(), before + 1);
});

test('a new source attempt on an admitted run is announced when it is recorded', async () => {
  const run = sourcedRun();
  store.updateRun(run.id, { sourcePlan: undefined, sourceProvenance: provenanceFor(run, []) });
  // The first execution also publishes the gateway's first receipt for this lock.
  await withRunSources(store.getRun(run.id)!, async () => {});
  store.updateRun(run.id, {
    sourceProvenance: { ...store.getRun(run.id)!.sourceProvenance!, receiptIds: ['earlier'] },
  });
  const before = revision();
  await withRunSources(store.getRun(run.id)!, async () => {});
  assert.equal(store.getRun(run.id)!.sourceProvenance!.receiptIds.length, 2);
  assert.equal(revision(), before + 1);
});

test.after(async () => {
  stopSourceReconciliation();
  for (const id of runs) {
    store.updateRun(id, { status: 'failed' });
    await store.deleteRun(id);
  }
  mock.restoreAll();
  await rm(root, { recursive: true, force: true });
});
