import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

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
const { sourceTestLock } = await import('./source.test-support.js');
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
      const lock = sourceTestLock('node-1', run.id);
      await deps.save({
        ...run,
        sourceProvenance: {
          state: 'locked',
          attemptId: `${run.id}:1`,
          lock,
          workerLock: lock,
          receiptIds: ['gateway-receipt', 'node-1-receipt'],
          bindings: [lock.packBindings.demo],
          attempts: [],
        },
      });
    },
  },
});
await import('../runtime/mock-pty.test-support.js');
const { SourceAuthority } = await import('./authority.js');
const { admitRunSources, initializeSources, stopSourceReconciliation } =
  await import('./runtime.js');
const { currentSourceResourceChanges } = await import('./change-signal.js');
const store = await import('../runs/store.js');

const revision = () => currentSourceResourceChanges()!.changes[0].revision;

test('a run admission is announced once its provenance is saved, before the next run.updated', async (t) => {
  t.mock.method(SourceAuthority, 'open', async () => ({
    recoverRunCreations: async () => {},
    startReconciliation: () => () => {},
    observe: () => () => {},
    activatedAt: () => '2020-01-01T00:00:00Z',
  }));
  await initializeSources();
  t.after(() => stopSourceReconciliation());
  const run = store.createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'PROJ-1' });
  t.after(async () => {
    store.updateRun(run.id, { status: 'failed' });
    await store.deleteRun(run.id);
  });
  const before = revision();
  await admitRunSources(run.id, { nodeId: 'node-1' });
  assert.ok(store.getRun(run.id)!.sourceProvenance);
  assert.equal(revision(), before + 1);
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});
