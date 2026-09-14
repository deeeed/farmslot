import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeSessionInfo } from '@farmslot/protocol';

import { nativeWorkerViewControl, type NativeWorkerViewTarget } from './native-worker-target';

const target: NativeWorkerViewTarget = {
  runId: 'run',
  contextId: 'dev',
  label: 'Worker',
  readOnly: false,
  binding: {
    sessionId: 'session',
    executionNodeId: 'node',
    ownerPrincipalId: 'owner',
    leaseId: 'lease',
    generation: 'generation',
    commandId: 'initial',
    acceptedAt: 'accepted',
  },
};
const session = {
  id: 'session',
  executionNodeId: 'node',
  ownerPrincipalId: 'owner',
  generation: 'generation',
  workerLeaseId: 'lease',
} as NativeSessionInfo;

test('worker controls require the exact live task binding and refuse stale or historical selection', () => {
  assert.deepEqual(nativeWorkerViewControl(target, session), {
    runId: 'run',
    contextId: 'dev',
    generation: 'generation',
    leaseId: 'lease',
  });
  for (const field of [
    'id',
    'executionNodeId',
    'ownerPrincipalId',
    'generation',
    'workerLeaseId',
  ] as const)
    assert.equal(
      nativeWorkerViewControl(target, { ...session, [field]: 'other' }),
      undefined,
      field,
    );
  assert.equal(nativeWorkerViewControl({ ...target, readOnly: true }, session), undefined);
  for (const binding of [
    { ...target.binding, closedAt: 'closed' },
    { ...target.binding, releasedAt: 'transferred' },
    { ...target.binding, acceptedAt: undefined },
    { ...target.binding, recovery: { fromGeneration: 'generation', commandId: 'resume' } },
  ])
    assert.equal(nativeWorkerViewControl({ ...target, binding }, session), undefined);
});
