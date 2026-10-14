import assert from 'node:assert/strict';
import test from 'node:test';

import type { BranchMaintenanceOperation } from '@farmslot/protocol';

import { MaintenanceRefusal } from '../run-engine/branch-maintenance.js';
import { makeRun } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';

import { updateStackedPrBranch } from './stack-retarget.js';

const run = makeRun({ slotId: 'retained-slot', prNumber: 7 });
const operation: BranchMaintenanceOperation = {
  id: 'pending-operation',
  ownerRunId: run.id,
  project: run.project,
  repo: '/retained',
  branch: 'child',
  baseRef: 'main',
  kind: 'graph-merge',
  sourceHeadSha: 'a'.repeat(40),
  remoteHeadSha: 'a'.repeat(40),
  targetSha: 'b'.repeat(40),
  comparisonBaseSha: 'c'.repeat(40),
  replayBoundarySha: 'c'.repeat(40),
  authorityHeadSha: 'a'.repeat(40),
  preparedAt: '2026-10-14T00:00:00Z',
};

function dependencies() {
  const calls: string[] = [];
  const deps: NonNullable<Parameters<typeof updateStackedPrBranch>[1]> = {
    project: async () => ({ repo: 'example/repo', base: 'main' }),
    loadSlot: async () => makeVars(),
    prepare: async () => operation,
    execute: async (_vars, selected) => {
      assert.equal(selected, operation);
      calls.push('execute-and-push');
    },
    complete: async (_run, selected) => {
      assert.equal(selected, operation);
      calls.push('renew');
      return undefined;
    },
    retire: async (_run, selected) => {
      assert.equal(selected, operation);
      calls.push('retire');
    },
  };
  return { deps, calls };
}

test('catch-up executes the pinned SDK merge and renews only after its leased push', async () => {
  const { deps, calls } = dependencies();
  assert.match((await updateStackedPrBranch(run, deps)).result, /merged main/);
  assert.deepEqual(calls, ['execute-and-push', 'renew']);
});

test('a merge conflict retires the input and preserves the existing worker fallback', async () => {
  const { deps, calls } = dependencies();
  deps.execute = async () => {
    throw new MaintenanceRefusal('GRAPH_MERGE_CONFLICT');
  };
  assert.match((await updateStackedPrBranch(run, deps)).result, /conflict/);
  assert.deepEqual(calls, ['retire']);
});

test('a changed target retires before refusing so a graph retry can prepare new input', async () => {
  const { deps, calls } = dependencies();
  deps.execute = async () => {
    throw new MaintenanceRefusal('TARGET_CHANGED');
  };
  await assert.rejects(updateStackedPrBranch(run, deps), /TARGET_CHANGED/);
  assert.deepEqual(calls, ['retire']);
});

test('an uncertain pushed merge never renews or retires publication authority', async () => {
  const { deps, calls } = dependencies();
  deps.complete = async () => {
    throw new MaintenanceRefusal('GRAPH_MERGE_CHANGED');
  };
  await assert.rejects(updateStackedPrBranch(run, deps), /GRAPH_MERGE_CHANGED/);
  assert.deepEqual(calls, ['execute-and-push']);
});
