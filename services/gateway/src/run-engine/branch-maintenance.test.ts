import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  type BranchMaintenanceCheckpoint,
  type BranchMaintenanceOperation,
  PipelineSteps,
} from '@farmslot/protocol';

import { makeVars } from '../runners/test-fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'branch-maintenance-store-'));
process.env.FARMSLOT_RUNS_DIR = path.join(directory, 'runs');
const runs = await import('../runs/store.js');
const maintenance = await import('./branch-maintenance.js');
test.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const initial: BranchMaintenanceCheckpoint = {
  source: 'local-git',
  baseRef: 'parent',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  replayBoundarySha: 'a'.repeat(40),
  diffHash: 'old-diff',
  capturedAt: '2026-10-14T00:00:00Z',
};

async function fixture(t: TestContext) {
  const owner = runs.createRun({ flowType: 'dev', project: 'example', ticketOrPr: 'STACK' });
  runs.updateRun(owner.id, {
    branch: 'child',
    prNumber: 7,
    status: 'done',
    stack: {
      baseBranch: 'parent',
      upstreamNodeId: 'up',
      upstreamRunId: 'up',
      upstreamPrNumber: 6,
      resolvedSha: 'a'.repeat(40),
    },
    engineState: { publishGate: { packageHash: 'frozen-package', maintainedSnapshot: initial } },
  });
  const worker = runs.createRun({
    flowType: 'pr-complete',
    project: 'example',
    ticketOrPr: 'example/repo#7',
    parentRunId: owner.id,
    slotId: 'local-test',
  });
  runs.updateRun(worker.id, { branch: 'child' });
  t.after(async () => {
    for (const run of [worker, owner]) {
      if (runs.getRun(run.id)) {
        runs.updateRun(run.id, { status: 'done' });
        await runs.deleteRun(run.id);
      }
    }
  });
  const operation: BranchMaintenanceOperation = {
    id: `operation-${worker.id}`,
    ownerRunId: owner.id,
    project: 'example',
    repo: makeVars().remoteRepo,
    branch: 'child',
    baseRef: 'parent',
    kind: 'rebase',
    sourceHeadSha: initial.headSha!,
    remoteHeadSha: initial.headSha!,
    targetSha: 'c'.repeat(40),
    comparisonBaseSha: initial.baseSha!,
    replayBoundarySha: initial.replayBoundarySha,
    authorityHeadSha: initial.headSha!,
    expectedCheckpoint: initial,
    preparedAt: '2026-10-14T00:01:00Z',
  };
  let inspections = 0;
  const deps: NonNullable<Parameters<typeof maintenance.completeBranchMaintenance>[2]> = {
    loadSlot: async () => makeVars(),
    runtime: async <T>(_vars: unknown, phase: string): Promise<T> => {
      if (phase === 'inspect') {
        inspections++;
        return operation as T;
      }
      assert.equal(phase, 'verify');
      return { headSha: 'd'.repeat(40), replayBoundarySha: operation.targetSha } as T;
    },
    capture: async (_vars, range) => {
      assert.equal(range?.committedBaseSha, operation.targetSha);
      assert.equal(range?.committedHeadSha, 'd'.repeat(40));
      return {
        snapshot: {
          source: 'local-git',
          capturedAt: new Date().toISOString(),
          baseRef: 'parent',
          baseSha: operation.targetSha,
          headSha: 'd'.repeat(40),
          diffHash: 'verified-diff',
          diffStat: { files: 1, additions: 1, deletions: 0 },
        },
      };
    },
  };
  return { owner, worker, operation, deps, inspections: () => inspections };
}

test('write-task retains the operation before handoff and restart reuses it', async (t) => {
  const { owner, worker, operation, deps, inspections } = await fixture(t);
  assert.equal(
    await maintenance.prepareBranchMaintenance(worker, makeVars(), 'main', 'rebase', deps),
    operation,
  );
  const persisted = JSON.parse(await readFile(runs.runRecordPath(worker.id), 'utf8'));
  assert.deepEqual(
    persisted.steps.find((step: { name: string }) => step.name === PipelineSteps.WRITE_TASK).outputs
      .branchMaintenanceOperation,
    operation,
  );
  assert.equal(
    await maintenance.prepareBranchMaintenance(
      structuredClone(worker),
      makeVars(),
      'main',
      'rebase',
      deps,
    ),
    operation,
  );
  assert.equal(inspections(), 1);
  const frozenGate = owner.engineState!.publishGate!.packageHash;
  const [first, retried] = await Promise.all([
    maintenance.completeBranchMaintenance(worker, operation, deps),
    maintenance.completeBranchMaintenance(worker, operation, deps),
  ]);
  assert.deepEqual(first, retried, 'identical successor is accepted inside the queued CAS');
  assert.equal(owner.engineState!.publishGate!.packageHash, frozenGate);
  assert.equal(owner.stack!.resolvedSha, initial.replayBoundarySha);
  assert.equal(
    worker.steps.find((step) => step.name === PipelineSteps.WRITE_TASK)!.outputs!
      .branchMaintenanceCompleted,
    true,
  );
  assert.equal(await maintenance.completeBranchMaintenance(worker, undefined, deps), undefined);
});

test('a stale renewal cannot overwrite a newer checkpoint or clear pending input', async (t) => {
  const { owner, worker, operation, deps } = await fixture(t);
  await maintenance.prepareBranchMaintenance(worker, makeVars(), 'main', 'rebase', deps);
  const newer = { ...initial, headSha: 'e'.repeat(40) };
  const capture = deps.capture;
  deps.capture = async (...args) => {
    const result = await capture(...args);
    runs.updateRun(owner.id, {
      engineState: {
        publishGate: { ...owner.engineState!.publishGate, maintainedSnapshot: newer },
      },
    });
    return result;
  };
  await assert.rejects(
    maintenance.completeBranchMaintenance(worker, operation, deps),
    /STALE_MAINTENANCE_RENEWAL/,
  );
  assert.deepEqual(owner.engineState!.publishGate!.maintainedSnapshot, newer);
  assert.equal(
    worker.steps.find((step) => step.name === PipelineSteps.WRITE_TASK)!.outputs!
      .branchMaintenanceCompleted,
    false,
  );
});

test('archived publishing authority renews without restoring its execution', async (t) => {
  const { owner, worker, operation, deps } = await fixture(t);
  await maintenance.prepareBranchMaintenance(worker, makeVars(), 'main', 'rebase', deps);
  assert.equal(await runs.archiveRun(owner.id), true);
  const file = path.join(directory, 'runs/archive', `${owner.id}.json`);
  const before = JSON.parse(await readFile(file, 'utf8'));
  await maintenance.completeBranchMaintenance(worker, operation, deps);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(runs.getRun(owner.id), undefined);
  assert.equal(after.engineState.publishGate.maintainedSnapshot.headSha, 'd'.repeat(40));
  after.engineState.publishGate.maintainedSnapshot =
    before.engineState.publishGate.maintainedSnapshot;
  assert.deepEqual(
    after,
    before,
    'archive lifecycle, task and frozen publication bytes remain unchanged',
  );
});

test('graph input survives pending updates and a different operation cannot replace it', async (t) => {
  const { owner, worker, operation, deps, inspections } = await fixture(t);
  operation.kind = 'graph-merge';
  assert.equal(
    await maintenance.prepareBranchMaintenance(owner, makeVars(), 'main', 'graph-merge', deps),
    operation,
  );
  assert.equal(
    await maintenance.prepareBranchMaintenance(owner, makeVars(), 'main', 'graph-merge', deps),
    operation,
  );
  assert.equal(inspections(), 1);
  await assert.rejects(
    maintenance.prepareBranchMaintenance(owner, makeVars(), 'main', 'rebase', deps),
    /MAINTENANCE_OPERATION_PENDING/,
  );
  // Completing an older context never clears a distinct newly retained operation.
  runs.updateRun(worker.id, {
    steps: worker.steps.map((step) =>
      step.name === PipelineSteps.WRITE_TASK
        ? { ...step, outputs: { branchMaintenanceOperation: { ...operation, id: 'replacement' } } }
        : step,
    ),
  });
  await maintenance.completeBranchMaintenance(worker, operation, deps);
  assert.equal(
    (
      worker.steps.find((step) => step.name === PipelineSteps.WRITE_TASK)!.outputs!
        .branchMaintenanceOperation as BranchMaintenanceOperation
    ).id,
    'replacement',
  );
});

test('missing archived contribution authority refuses instead of becoming ordinary', async (t) => {
  const { worker, deps } = await fixture(t);
  runs.updateRun(worker.id, { parentRunId: 'unavailable-ancestor' });
  await assert.rejects(
    maintenance.prepareBranchMaintenance(worker, makeVars(), 'main', 'rebase', deps),
    /ancestor.*unavailable/,
  );
});

test('a retarget during capture and a rebound checkout both refuse renewal', async (t) => {
  const { owner, worker, operation, deps } = await fixture(t);
  await maintenance.prepareBranchMaintenance(worker, makeVars(), 'main', 'rebase', deps);
  await assert.rejects(
    maintenance.prepareBranchMaintenance(
      worker,
      makeVars({ remoteRepo: '/other-checkout' }),
      'main',
      'rebase',
      deps,
    ),
    /MAINTENANCE_CHECKOUT_CHANGED/,
  );
  const capture = deps.capture;
  deps.capture = async (...args) => {
    const result = await capture(...args);
    runs.updateRun(owner.id, {
      stack: { ...owner.stack!, retargetedTo: 'main', upstreamMergeSha: 'f'.repeat(40) },
    });
    return result;
  };
  await assert.rejects(
    maintenance.completeBranchMaintenance(worker, operation, deps),
    /MAINTENANCE_BASE_CHANGED/,
  );
  assert.deepEqual(owner.engineState!.publishGate!.maintainedSnapshot, initial);
});

test('write-task replay keeps immutable input while clearing ordinary telemetry', async (t) => {
  const { worker, operation, deps } = await fixture(t);
  await maintenance.prepareBranchMaintenance(worker, makeVars(), 'main', 'rebase', deps);
  const prior = worker.steps.find((step) => step.name === PipelineSteps.WRITE_TASK)!.outputs;
  const retained = maintenance.retainedMaintenanceStepOutputs(PipelineSteps.WRITE_TASK, {
    ...prior,
    skipped: true,
  });
  assert.deepEqual(retained, {
    branchMaintenanceOperation: operation,
    branchMaintenanceCompleted: false,
  });
  assert.equal(maintenance.retainedMaintenanceStepOutputs(PipelineSteps.MONITOR, prior), undefined);
  runs.updateRunStep(worker.id, PipelineSteps.WRITE_TASK, { outputs: retained });
  assert.equal(
    await maintenance.prepareBranchMaintenance(worker, makeVars(), 'main', 'rebase', deps),
    operation,
  );
});
