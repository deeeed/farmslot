import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Methods, type Principal, type Run } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { makeRun } from '../methods/run/test-fixtures.js';

import { runWithSessionOriginator } from './work-originator.js';

await import('../runtime/mock-pty.test-support.js');
let runs: Run[] = [];
let ownerChecks = 0;
mock.module('../runs/store.js', {
  namedExports: {
    getAllRuns: () => runs,
    getRun: (id: string) => runs.find((run) => run.id === id),
  },
});
mock.module('./native-worker-owner.js', {
  namedExports: {
    assertNativeRunOwner: () => {
      ownerChecks++;
      throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native worker belongs to another principal');
    },
  },
});
const { assertNativeWorkerRpcAccess } = await import('./native-worker-access.js');
const admin: Principal = {
  id: 'maintenance',
  subject: { type: 'service', displayName: 'Maintenance' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const operator: Principal = {
  ...admin,
  id: 'operator',
  roles: [{ role: 'operator', scope: { kind: 'global' } }],
};

function closed(): Run {
  const run = makeRun({ id: 'retired', status: 'done', flowType: 'review-pr' });
  run.transport = 'native';
  run.nativeOwnerPrincipalId = 'retired-owner';
  run.reviewWorkspace = {
    workspaceId: 'workspace',
    machine: 'node',
    executionNodeId: 'local',
    checkoutPath: '/managed/runs/workspace/source',
    taskPath: '/managed/runs/workspace/task',
    artifactPath: '/managed/runs/workspace/task/artifacts',
    cleanedAt: '2026-01-01T00:00:00Z',
  };
  return run;
}

test('global admin cleanup can reclaim released terminal data without adopting a retired owner', async () => {
  runs = [closed()];
  ownerChecks = 0;
  await runWithSessionOriginator(admin, () =>
    assertNativeWorkerRpcAccess(Methods.RUN_CLEANUP, { dryRun: true }),
  );
  assert.equal(ownerChecks, 0);
  assert.equal(runs[0].nativeOwnerPrincipalId, 'retired-owner');
  await assert.rejects(
    runWithSessionOriginator(admin, () =>
      assertNativeWorkerRpcAccess(Methods.RUN_CANCEL, { runId: 'retired' }),
    ),
    /another principal/,
  );
  assert.equal(ownerChecks, 1);
});

test('cleanup does not grant an operator the global admin maintenance exception', async () => {
  runs = [closed()];
  ownerChecks = 0;
  await assert.rejects(
    runWithSessionOriginator(operator, () => assertNativeWorkerRpcAccess(Methods.RUN_CLEANUP, {})),
    /another principal/,
  );
  assert.equal(ownerChecks, 1);
});

for (const state of ['active', 'held worker', 'open gate', 'uncleaned workspace'] as const) {
  test(`cleanup keeps the native owner check for ${state}`, async () => {
    const run = closed();
    if (state === 'active') run.status = 'monitoring';
    if (state === 'uncleaned workspace') delete run.reviewWorkspace!.cleanedAt;
    if (state === 'open gate')
      run.decisions = [
        {
          id: 'gate',
          type: 'engine_output_review',
          title: 'Review',
          description: 'Retain evidence',
          createdAt: '2026-01-01T00:00:00Z',
          actions: [],
        },
      ];
    if (state === 'held worker')
      run.agentContexts = [
        {
          id: 'review',
          role: 'review',
          label: 'Review',
          status: 'working',
          runId: run.id,
          slotId: null,
          nativeSession: {
            sessionId: 'session',
            leaseId: 'lease',
            commandId: 'command',
            ownerPrincipalId: 'retired-owner',
            executionNodeId: 'local',
          },
        },
      ];
    runs = [run];
    ownerChecks = 0;
    await assert.rejects(
      runWithSessionOriginator(admin, () => assertNativeWorkerRpcAccess(Methods.RUN_CLEANUP, {})),
      /another principal/,
    );
    assert.equal(ownerChecks, 1);
  });
}
