import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeSessionInfo, NativeSessionReadResult } from '@farmslot/protocol';

import {
  assertNativeWorkerViewPage,
  nativeWorkerViewControl,
  nativeWorkerViewKey,
  nativeWorkerViewPin,
  type NativeWorkerViewTarget,
} from './native-worker-target.js';

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

test('history pins remain readable after release and reject unscoped or successor pages', () => {
  const released = {
    ...target,
    readOnly: true,
    binding: { ...target.binding, releasedAt: 'released' },
  };
  assert.equal(nativeWorkerViewPin(released).leaseId, target.binding.leaseId);
  const page = {
    session: { ...session, workerManaged: true },
    events: [],
    cursor: 7,
    commands: [],
    pendingRequests: [],
    hasMore: false,
    scope: { leaseId: 'lease', startAfter: 7, endAt: 7, released: true },
  } as NativeSessionReadResult;
  assert.doesNotThrow(() => assertNativeWorkerViewPage(released, page));
  for (const invalid of [
    { ...page, scope: undefined },
    { ...page, scope: { ...page.scope!, leaseId: 'successor' } },
    { ...page, cursor: 6 },
    { ...page, pendingRequests: [{ sequence: 8 }] },
    { ...page, events: [{ sequence: 8 }] },
  ])
    assert.throws(
      () => assertNativeWorkerViewPage(released, invalid as NativeSessionReadResult),
      /scope/,
    );
});

test('draft scope isolates tasks and roles while a process restart preserves the same task draft', () => {
  for (const changed of [
    { ...target, runId: 'next' },
    { ...target, contextId: 'review' },
    { ...target, binding: { ...target.binding, leaseId: 'next' } },
    { ...target, binding: { ...target.binding, executionNodeId: 'other' } },
  ])
    assert.notEqual(nativeWorkerViewKey(changed), nativeWorkerViewKey(target));
  assert.equal(
    nativeWorkerViewKey({ ...target, binding: { ...target.binding, generation: 'resumed' } }),
    nativeWorkerViewKey(target),
  );
});
