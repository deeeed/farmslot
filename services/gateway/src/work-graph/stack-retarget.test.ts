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
  const calls: string[][] = [];
  const deps: NonNullable<Parameters<typeof updateStackedPrBranch>[1]> = {
    project: async () => ({ repo: 'example/repo', base: 'main' }),
    loadSlot: async () => makeVars(),
    prepare: async () => operation,
    complete: async () => undefined,
    github: async (args) => {
      calls.push(args);
      return { stdout: '{}', stderr: '', exitCode: 0 };
    },
  };
  return { deps, calls };
}

test('catch-up reconciles a verified pending merge without sending another update', async () => {
  const { deps, calls } = dependencies();
  const result = await updateStackedPrBranch(run, deps);
  assert.match(result.result, /reconciled main/);
  assert.deepEqual(calls, []);
});

test('catch-up leases the exact child and polls until asynchronous merge verifies', async () => {
  const { deps, calls } = dependencies();
  let attempts = 0;
  deps.complete = async (_run, selected) => {
    assert.equal(selected, operation, 'polls retain the pinned operation');
    if (++attempts < 3) throw new MaintenanceRefusal('GRAPH_UPDATE_PENDING');
    return undefined;
  };
  assert.match((await updateStackedPrBranch(run, deps)).result, /merged main/);
  assert.equal(attempts, 3);
  assert.deepEqual(calls, [
    [
      '-X',
      'PUT',
      'repos/example/repo/pulls/7/update-branch',
      '-f',
      `expected_head_sha=${operation.remoteHeadSha}`,
    ],
  ]);
});

test('a changed merge or target refuses before another remote mutation', async () => {
  const { deps, calls } = dependencies();
  deps.complete = async () => {
    throw new MaintenanceRefusal('GRAPH_MERGE_CHANGED');
  };
  await assert.rejects(updateStackedPrBranch(run, deps), /GRAPH_MERGE_CHANGED/);
  assert.deepEqual(calls, []);
});
